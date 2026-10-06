/**
 * dsh-bridge-llm-plugin —— 把**已登录的 deepseek 网页会话**注册成 DSH 的模型 provider。
 *
 * ⚠️ 纯 ESM JS（宿主直接 import，不经转译）—— 不要写 TypeScript 类型语法。
 *
 * 与 `dsh-bridge-plugin`（工具插件）**分成两个包**是刻意的：
 *   工具插件 `inject: ['tools']`（已跑通，别动）；
 *   本插件 `inject: ['llm']` —— 若 `llm` 服务不可用，只会让**本插件**变 PENDING，
 *   **不会**把已经能用的原生工具一起拖下水（两个 fiber 相互独立）。
 *
 * 诊断：沿用工具插件验证过的**面包屑日志**技法 —— 导入期 / apply 入口 / 每一步 /
 *      每个异常都写文件，这样即使 fiber 失败、UI 不给原因，也能从文件读到确切失败点。
 *
 * @module dsh-bridge-llm-plugin
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { McpStdioClient } from './mcp-client.js'
import { createDeepseekWebAdapter } from './adapter.js'

export const name = 'dsh-bridge-llm-plugin'

/** 需要 LLM 运行时就绪（Cordis 会等 `ctx.llm` 可用后再调 `apply`）。 */
export const inject = ['llm']

/** 诊断日志路径（固定绝对路径，便于开发期从外部读取）。 */
const DIAG_LOG = 'D:\\claude-code\\dsh-bridge-llm-plugin\\diag\\boot.log'

const CONFIG_DEFAULTS = {
  command: 'uv',
  args: ['run', '--directory', 'D:/claude-code/dsh-bridge', 'dsh-bridge'],
  cwd: 'D:\\claude-code\\dsh-bridge',
  env: {},
  toolCallTimeoutMs: 180_000,
  provider: 'deepseek-web',
  modelId: 'deepseek-web',
  displayName: 'DeepSeek (网页登录态)',
  bootstrapProbe: false,
}

/**
 * 面包屑日志。**永远不会抛**。
 * @param {string} stage
 * @param {unknown} [detail]
 */
function diag(stage, detail) {
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    let extra = ''
    if (detail !== undefined) {
      try {
        extra = ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
      } catch {
        extra = ' ' + String(detail)
      }
    }
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} [${stage}]${extra}\n`, 'utf8')
  } catch {
    // 吞掉：诊断失败绝不能影响插件加载
  }
}

diag('MODULE-IMPORTED', { pid: process.pid, node: process.version })

/**
 * 合并默认值并做最小校验。
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveConfig(raw) {
  const merged = { ...CONFIG_DEFAULTS, ...(raw ?? {}) }
  if (typeof merged.command !== 'string' || merged.command.trim() === '') {
    throw new Error('dsh-bridge-llm-plugin: config.command 必须是非空字符串')
  }
  if (!Array.isArray(merged.args) || merged.args.some((a) => typeof a !== 'string')) {
    throw new Error('dsh-bridge-llm-plugin: config.args 必须是字符串数组')
  }
  if (typeof merged.cwd !== 'string') {
    throw new Error('dsh-bridge-llm-plugin: config.cwd 必须是字符串')
  }
  if (merged.env === null || typeof merged.env !== 'object' || Array.isArray(merged.env)) {
    throw new Error('dsh-bridge-llm-plugin: config.env 必须是字符串字典')
  }
  if (typeof merged.toolCallTimeoutMs !== 'number' || merged.toolCallTimeoutMs < 1000) {
    throw new Error('dsh-bridge-llm-plugin: config.toolCallTimeoutMs 必须是不小于 1000 的数字')
  }
  if (typeof merged.provider !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(merged.provider)) {
    throw new Error('dsh-bridge-llm-plugin: config.provider 必须是 1-32 位字母/数字/下划线/连字符')
  }
  if (typeof merged.modelId !== 'string' || merged.modelId.trim() === '') {
    throw new Error('dsh-bridge-llm-plugin: config.modelId 必须是非空字符串')
  }
  return {
    command: merged.command,
    args: [...merged.args],
    cwd: merged.cwd,
    env: { ...merged.env },
    toolCallTimeoutMs: merged.toolCallTimeoutMs,
    provider: merged.provider,
    modelId: merged.modelId,
    displayName: typeof merged.displayName === 'string' ? merged.displayName : 'DeepSeek (网页登录态)',
    bootstrapProbe: merged.bootstrapProbe === true,
  }
}

/** Standard Schema v1（宿主 `vendor/cordis/src/fiber.ts` 调 `Config['~standard'].validate`）。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-bridge-llm-plugin',
    validate(value) {
      try {
        return { value: resolveConfig(value) }
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }],
        }
      }
    },
  },
}

/**
 * 插件入口：注册 LLM adapter。
 *
 * @param {any} ctx Cordis 上下文（携带 `llm`）
 * @param {Record<string, unknown>} [config]
 */
export async function apply(ctx, config) {
  diag('APPLY-ENTER', {
    configKeys: config === undefined ? null : Object.keys(config),
    ctxKeys: (() => {
      try {
        return Object.keys(ctx)
      } catch {
        return 'keys() threw'
      }
    })(),
    hasLlm: typeof ctx?.llm === 'object' && ctx?.llm !== null,
    hasRegisterAdapter: typeof ctx?.llm?.registerAdapter === 'function',
    hasEffect: typeof ctx?.effect === 'function',
  })

  let resolved
  try {
    resolved = resolveConfig(config)
    diag('CONFIG-OK', resolved)
  } catch (error) {
    diag('CONFIG-FAILED', error?.stack ?? String(error))
    throw error
  }

  if (typeof ctx?.llm?.registerAdapter !== 'function') {
    // 响亮地失败：inject 应已保证 ctx.llm 就绪，走到这里说明宿主契约变了。
    diag('LLM-SERVICE-MISSING')
    throw new Error(
      'dsh-bridge-llm-plugin: ctx.llm.registerAdapter 不可用 —— 宿主没有提供 llm 服务？'
      + '（inject: [\'llm\'] 应已保证它就绪）',
    )
  }

  const client = new McpStdioClient({
    command: resolved.command,
    args: resolved.args,
    cwd: resolved.cwd,
    env: resolved.env,
    toolCallTimeoutMs: resolved.toolCallTimeoutMs,
  })
  ctx.effect(() => () => {
    diag('EFFECT-DISPOSE')
    client.dispose()
  })

  const adapter = createDeepseekWebAdapter({
    client,
    provider: resolved.provider,
    modelId: resolved.modelId,
    displayName: resolved.displayName,
    diag,
  })

  try {
    ctx.llm.registerAdapter([resolved.provider], adapter)
    diag('ADAPTER-REGISTERED', { provider: resolved.provider, modelId: resolved.modelId })
  } catch (error) {
    // 注册失败**不让 fiber 失败**（避免插件行变「异常」而掩盖真正原因）；
    // 但日志会留下完整错误栈。真正想让它响亮时，把下面 return 改成 throw。
    diag('ADAPTER-REGISTER-FAILED', error?.stack ?? String(error))
    return
  }

  // 🌸 可选自检：把一次真实「模型解析」走通（不碰真站，纯本地方法调用），
  //    用来证明 adapter 契约完整（7 个方法一个不缺）。
  if (resolved.bootstrapProbe) {
    try {
      const models = await adapter.listModels(resolved.provider)
      const prepared = await adapter.prepareCall(resolved.provider, resolved.modelId)
      diag('BOOTSTRAP-PROBE-OK', {
        models: models.map((m) => m.id),
        resolvedModel: prepared.model,
        hasStream: typeof prepared.stream === 'function',
      })
    } catch (error) {
      diag('BOOTSTRAP-PROBE-FAILED', error?.stack ?? String(error))
    }
  }

  diag('APPLY-DONE')
}
