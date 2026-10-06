/**
 * deepseek 网页会话 → DSH LLM adapter（**鸭子类型**，不继承 `LlmAdapter`）。
 *
 * 为什么鸭子类型：`registerAdapter()` 不做 `instanceof` 检查（源码确认：它只把
 * adapter 交给 `prepareRoutes`，流式时调 `adapter.stream(...)`），而
 * `@deepseek-ai/dsh-llm` 在本机 profile 里**解析不到**（HANDOVER §12.4 坑 2）。
 * 所以只要**把基类的全部方法都实现**，就能注册成功 —— 缺一个就是 `undefined` → TypeError。
 *
 * 基类方法全集（`packages/llm/llm/src/index.ts` LlmAdapter）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing / listModels /
 *   resolveModel / prepareCall / **stream（唯一抽象方法）**
 *
 * @module dsh-bridge-llm-plugin/adapter
 */

/** 一次请求里最多回带多少条历史消息（太长会让网页输入框被灌爆）。 */
const MAX_HISTORY_MESSAGES = 6
/** 单条历史消息最多取多少字符。 */
const MAX_HISTORY_CHARS = 600

/**
 * 把 DSH 的消息内容块转成纯文本。
 * @param {unknown} content 消息 content（可能是字符串或内容块数组）
 * @returns {string}
 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 由 `GenerateOptions` 组装发给网页聊天的提示词。
 *
 * ⚠️ 网页聊天**没有真正的多轮上下文 API**：每次调用都是一个新输入。
 *    所以这里把 system 与最近若干轮历史压成一段文本一起发过去。
 * @param {{ system?: string, messages?: unknown[] }} options
 * @returns {string}
 */
export function buildPrompt(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const users = messages.filter((m) => m && m.role === 'user')
  const lastUser = users.length > 0 ? users[users.length - 1] : messages[messages.length - 1]
  const question = contentToText(lastUser?.content).trim()

  const parts = []
  const system = typeof options?.system === 'string' ? options.system.trim() : ''
  if (system) parts.push(system)

  // 历史：取最后 N 条（不含最后那条用户消息本身）
  const history = messages.slice(-MAX_HISTORY_MESSAGES - 1, -1)
  const lines = []
  for (const message of history) {
    if (!message || typeof message.role !== 'string') continue
    const text = contentToText(message.content).trim()
    if (!text) continue
    const clipped = text.length > MAX_HISTORY_CHARS ? text.slice(0, MAX_HISTORY_CHARS) + '…' : text
    lines.push(`${message.role}: ${clipped}`)
  }
  if (lines.length > 0) {
    parts.push('--- 先前的对话（供参考） ---\n' + lines.join('\n'))
  }
  if (question) parts.push(question)

  return parts.join('\n\n').trim() || '(空提示)'
}

/**
 * G20 前置闸门：站点冻结/陈旧时**拒绝调用**，避免误触发真站 send（= 4 站吊销）。
 *
 * 与工具插件同一逻辑：bridge 的 `ask` 路径**不检查** G20（源码确认），
 * 所以必须由插件层兜住。`route_task` 是纯逻辑（不起浏览器、不 send），预检零风险。
 *
 * @param {{ callTool: (name: string, args: object) => Promise<string> }} client
 * @param {string} site
 * @param {(stage: string, detail?: unknown) => void} [diag]
 */
export async function assertNotBlocked(client, site, diag = () => {}) {
  let status
  try {
    status = JSON.parse(await client.callTool('route_task', { prompt: '__g20_preflight__' }))
  } catch (error) {
    diag('G20-PREFLIGHT-ERROR', error?.stack ?? String(error))
    throw new Error(
      'G20 前置检查失败，为安全起见拒绝调用（避免误触发真站 send）。原因：'
      + (error instanceof Error ? error.message : String(error)),
    )
  }
  const entry = status?.verify_status?.[site]
  if (!entry) {
    diag('G20-PREFLIGHT-NO-ENTRY', status)
    throw new Error(`G20 前置检查读不到 ${site} 的 verify 状态，为安全起见拒绝调用。`)
  }
  if (entry.blocked === true) {
    const hours = typeof entry.hours_left === 'number' ? entry.hours_left : '?'
    diag('G20-PREFLIGHT-BLOCKED', { site, hours_left: hours })
    throw new Error(
      `⛔ G20 频控铁律：${site} 处于冻结/陈旧状态（老化后剩余 ${hours}h < 6h 阈值），`
      + `已拒绝调用以免吊销账号。请先跑 \`uv run --no-sync dsh-login ${site}\` 重过 verify。`,
    )
  }
  diag('G20-PREFLIGHT-PASS', { site, hours_left: entry.hours_left })
}

/**
 * 把整段文本切成若干 delta，让 DSH 的 UI 有「流式」观感
 * （网页聊天本身是整段返回，拿不到真实逐 token 流）。
 * @param {string} text
 * @param {number} [size]
 * @returns {string[]}
 */
export function sliceForStreaming(text, size = 24) {
  if (!text) return []
  const chunks = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

/**
 * 建一个鸭子类型的 `LlmAdapter`。
 *
 * @param {object} options
 * @param {{ callTool: (name: string, args: object) => Promise<string> }} options.client 到 bridge 的 MCP 客户端
 * @param {string} [options.provider] provider 路由名（默认 `deepseek-web`）
 * @param {string} [options.modelId] 模型 id（默认 `deepseek-web`）
 * @param {string} [options.displayName] 在 DSH 模型选择器里显示的名字
 * @param {(stage: string, detail?: unknown) => void} [options.diag] 诊断日志
 * @param {(text: string) => void} [options.onReply] 收到回复后的回调（诊断用）
 */
export function createDeepseekWebAdapter({
  client,
  provider = 'deepseek-web',
  modelId = 'deepseek-web',
  displayName = 'DeepSeek (网页登录态)',
  diag = () => {},
  onReply,
} = {}) {
  return {
    // ── 以下 6 个是基类有默认实现的方法，鸭子类型必须全部补上 ──

    /** @param {string} route */
    providerInfo(route) {
      return { id: route, name: 'DeepSeek 网页聊天（dsh-bridge）' }
    },

    /** @param {string} _route */
    providerRetryPolicy(_route) {
      return undefined
    },

    /**
     * @param {string} _route
     * @param {string} _model
     */
    imageRequestPricing(_route, _model) {
      return undefined
    },

    /**
     * 让 DSH 的模型选择器能看到这个模型。
     * @param {string} route
     */
    async listModels(route) {
      return [{
        provider: route,
        id: modelId,
        name: displayName,
        description:
          '通过 dsh-bridge 驱动本机已登录的 deepseek.com 网页会话；整段返回、'
          + '不支持工具调用（网页 UI 无结构化 tool-call）',
        inputModalities: ['text'],
      }]
    },

    /**
     * @param {string} route
     * @param {string} model
     */
    async resolveModel(route, model) {
      return {
        provider: route,
        id: model,
        name: displayName,
        contextWindow: 64_000,
      }
    },

    /**
     * @param {string} route
     * @param {string} model
     * @param {AbortSignal} [signal]
     */
    async prepareCall(route, model, signal) {
      return {
        model: await this.resolveModel(route, model, signal),
        stream: (options) => this.stream(options),
      }
    },

    // ── 唯一抽象方法：把 bridge 的整段回复作为 chunk 流吐出 ──

    /**
     * @param {{ messages?: unknown[], system?: string, signal?: AbortSignal }} options
     * @returns {AsyncGenerator<object>}
     */
    async *stream(options) {
      const signal = options?.signal
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted before start' } } }
        return
      }

      await assertNotBlocked(client, 'deepseek', diag)

      const prompt = buildPrompt(options)
      diag('LLM-REQUEST', { chars: prompt.length })

      const raw = await client.callTool('ask_deepseek', { prompt })
      const reply = parseReply(raw)
      if (typeof onReply === 'function') {
        try {
          onReply(reply)
        } catch {
          // 诊断回调不能影响主流程
        }
      }
      diag('LLM-REPLY', { chars: reply.length })

      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const delta of sliceForStreaming(reply)) {
        if (signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted mid-stream' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * 解析 bridge 的 `ask_deepseek` 返回（JSON 字符串或纯文本）。
 * @param {string} raw
 * @returns {string}
 */
export function parseReply(raw) {
  const text = (raw ?? '').trim()
  if (!text) return '(deepseek 返回空结果)'
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (unfenced.startsWith('{')) {
    try {
      const parsed = JSON.parse(unfenced)
      if (typeof parsed?.reply === 'string') return parsed.reply
      return unfenced
    } catch {
      // 落到纯文本
    }
  }
  return text
}
