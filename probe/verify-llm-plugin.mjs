/**
 * LLM 插件自检 —— 全程 **stub 客户端，绝不碰真站**。
 *
 * 覆盖：
 *   1. 纯函数层：resolveConfig / contentToText / buildPrompt / parseReply / sliceForStreaming
 *   2. 契约层：adapter 是否实现了 `LlmAdapter` 基类的**全部**方法
 *      （鸭子类型下缺一个就是 undefined → TypeError）
 *   3. 流层：blocked → 拒绝；open → 产出合法的 StreamChunk 序列
 *   4. G20 闸门：4 种情形（blocked / open / 预检抛错 / 缺条目）
 *
 * 用法：node probe/verify-llm-plugin.mjs
 */
import {
  resolveConfig,
  Config,
} from '../lib/index.js'
import {
  createDeepseekWebAdapter,
  assertNotBlocked,
  buildPrompt,
  contentToText,
  parseReply,
  sliceForStreaming,
} from '../lib/adapter.js'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures++
    console.log(`  ✗ ${label}\n      ${error.message}`)
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures++
    console.log(`  ✗ ${label}\n      ${error.message}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** 只实现 callTool 的假 client。 */
const stubClient = (toolResults) => ({
  calls: [],
  async callTool(toolName, args) {
    this.calls.push({ toolName, args })
    const value = toolResults[toolName]
    if (value === undefined) throw new Error(`stub 未准备 ${toolName}`)
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value(args) : value
  },
})

const blocked = JSON.stringify({
  ok: false,
  verify_status: { deepseek: { hours_left: 0, blocked: true, source: 'cookie_probe' } },
})
const open = JSON.stringify({
  ok: true,
  verify_status: { deepseek: { hours_left: 11.5, blocked: false, source: 'manual_login' } },
})
const replyJson = JSON.stringify({ reply: '你好呀 🌸', conversation_id: 'abc' })

console.log('=== 1. 纯函数层 ===')

check('resolveConfig 空配置 → 默认值', () => {
  const c = resolveConfig(undefined)
  assert(c.command === 'uv', c.command)
  assert(c.provider === 'deepseek-web', c.provider)
  assert(c.modelId === 'deepseek-web', c.modelId)
  assert(c.toolCallTimeoutMs === 180000, String(c.toolCallTimeoutMs))
})

check('resolveConfig 非法 provider 要响亮', () => {
  let threw = false
  try {
    resolveConfig({ provider: 'bad provider!' })
  } catch {
    threw = true
  }
  assert(threw, 'provider 含非法字符应抛错')
})

check('Config.~standard.validate 返回合并值', () => {
  const out = Config['~standard'].validate({ provider: 'my-ds' })
  assert(out.value.provider === 'my-ds', JSON.stringify(out.value))
  assert(out.value.modelId === 'deepseek-web', '未补默认值')
})

check('contentToText 支持字符串与块数组', () => {
  assert(contentToText('abc') === 'abc', '字符串')
  assert(contentToText([{ type: 'text', text: 'x' }, { type: 'image' }]) === 'x', '块数组')
  assert(contentToText(undefined) === '', 'undefined')
})

check('buildPrompt 带 system + 历史 + 当前问题', () => {
  const p = buildPrompt({
    system: 'SYS',
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ],
  })
  assert(p.includes('SYS'), '应含 system')
  assert(p.includes('user: 第一问'), '应含历史')
  assert(p.includes('assistant: 第一答'), '应含历史')
  assert(p.trim().endsWith('第二问'), `当前问题应在末尾，实际：${p}`)
})

check('buildPrompt 无 system 无历史时就是问题本身', () => {
  const p = buildPrompt({ messages: [{ role: 'user', content: '只有问题' }] })
  assert(p === '只有问题', p)
})

check('parseReply 解析 JSON 与纯文本', () => {
  assert(parseReply(replyJson) === '你好呀 🌸', 'JSON')
  assert(parseReply('```json\n{"reply":"A"}\n```') === 'A', '围栏')
  assert(parseReply('⛔ 冻结') === '⛔ 冻结', '纯文本')
})

check('sliceForStreaming 切分正确', () => {
  assert(sliceForStreaming('').length === 0, '空')
  assert(sliceForStreaming('abcdef', 2).join('') === 'abcdef', '拼接应还原')
  assert(sliceForStreaming('abcdef', 2).length === 3, '应切 3 段')
})

console.log('\n=== 2. adapter 契约完整性（鸭子类型：一个方法都不能缺）===')

const adapter = createDeepseekWebAdapter({ client: stubClient({}), diag: () => {} })
const REQUIRED = [
  'providerInfo', 'providerRetryPolicy', 'imageRequestPricing',
  'listModels', 'resolveModel', 'prepareCall', 'stream',
]
for (const method of REQUIRED) {
  check(`实现了 ${method}()`, () => {
    assert(typeof adapter[method] === 'function', `缺 ${method}（undefined → TypeError）`)
  })
}

await checkAsync('listModels 返回本模型', async () => {
  const models = await adapter.listModels('deepseek-web')
  assert(models.length === 1, String(models.length))
  assert(models[0].provider === 'deepseek-web', models[0].provider)
  assert(models[0].id === 'deepseek-web', models[0].id)
})

await checkAsync('resolveModel 返回元信息', async () => {
  const m = await adapter.resolveModel('deepseek-web', 'deepseek-web')
  assert(m.provider === 'deepseek-web' && m.id === 'deepseek-web', JSON.stringify(m))
})

console.log('\n=== 3. G20 闸门（stub，绝不碰真站）===')

await checkAsync('blocked=true → 拒绝', async () => {
  let threw = false
  try {
    await assertNotBlocked(stubClient({ route_task: blocked }), 'deepseek')
  } catch (error) {
    threw = true
    assert(error.message.includes('G20'), error.message)
    assert(error.message.includes('dsh-login'), '应给出 dsh-login 指引')
  }
  assert(threw, 'blocked 必须抛错')
})

await checkAsync('blocked=false → 放行', async () => {
  await assertNotBlocked(stubClient({ route_task: open }), 'deepseek')
})

await checkAsync('预检抛错 → 保守拒绝', async () => {
  let threw = false
  try {
    await assertNotBlocked(stubClient({ route_task: new Error('桥接挂了') }), 'deepseek')
  } catch (error) {
    threw = true
    assert(error.message.includes('拒绝调用'), error.message)
  }
  assert(threw, '预检失败必须保守拒绝')
})

await checkAsync('缺站点条目 → 拒绝', async () => {
  let threw = false
  try {
    await assertNotBlocked(stubClient({ route_task: JSON.stringify({ verify_status: {} }) }), 'deepseek')
  } catch {
    threw = true
  }
  assert(threw, '缺条目必须拒绝')
})

console.log('\n=== 4. stream() 产出合法 StreamChunk 序列 ===')

await checkAsync('未冻结 → 产出 block-start/text-delta/block-end/finish', async () => {
  const client = stubClient({ route_task: open, ask_deepseek: replyJson })
  const a = createDeepseekWebAdapter({ client, diag: () => {} })
  const chunks = []
  for await (const chunk of a.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk)
  }
  const types = chunks.map((c) => c.type)
  assert(types[0] === 'block-start', `第一块应为 block-start，实际 ${types[0]}`)
  assert(types.includes('text-delta'), '应有 text-delta')
  assert(types.includes('block-end'), '应有 block-end')
  assert(types[types.length - 1] === 'finish', `最后应为 finish，实际 ${types[types.length - 1]}`)
  // 文本要能还原
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert(text === '你好呀 🌸', `还原文本不对：${text}`)
  // finish 原因
  const finish = chunks[chunks.length - 1]
  assert(finish.reason?.kind === 'stop', JSON.stringify(finish.reason))
  // 预检确实发生过（G20 闸门在流里生效）
  assert(client.calls.some((c) => c.toolName === 'route_task'), '应先调 route_task 做 G20 预检')
})

await checkAsync('冻结 → stream 抛 G20 错误且**不**调 ask_deepseek', async () => {
  const client = stubClient({ route_task: blocked, ask_deepseek: replyJson })
  const a = createDeepseekWebAdapter({ client, diag: () => {} })
  let threw = false
  try {
    for await (const _ of a.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // 不应产出任何 chunk
    }
  } catch (error) {
    threw = true
    assert(error.message.includes('G20'), error.message)
  }
  assert(threw, '冻结时应抛错')
  assert(!client.calls.some((c) => c.toolName === 'ask_deepseek'), '❌ 冻结时绝不该调 ask_deepseek！')
})

await checkAsync('signal 已 abort → 立即以 aborted 收尾', async () => {
  const client = stubClient({})
  const a = createDeepseekWebAdapter({ client, diag: () => {} })
  const controller = new AbortController()
  controller.abort()
  const chunks = []
  for await (const chunk of a.stream({ messages: [], signal: controller.signal })) chunks.push(chunk)
  assert(chunks.length === 1 && chunks[0].type === 'finish', JSON.stringify(chunks))
  assert(chunks[0].reason.kind === 'aborted', JSON.stringify(chunks[0].reason))
  assert(client.calls.length === 0, 'abort 后不该发起任何调用')
})

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ===`)
process.exit(failures === 0 ? 0 : 1)
