/**
 * 检查 npm 上某个实验插件包对当前 DSH runtime 的兼容性。
 * 复现 `evaluatePluginCompatibility`（packages/boot/app-boot/src/plugin-compatibility.ts）。
 *
 * 用法：node probe/check-npm-compat.mjs <包名> [runtimeVersion]
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'

const pkgName = process.argv[2] ?? '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
const runtime = process.argv[3] ?? '0.2.0-rc.2'

const profileDir = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop')
const requireFromProfile = createRequire(path.join(profileDir, 'noop.js'))
const semver = requireFromProfile('semver')

const encoded = encodeURIComponent(pkgName)
const res = await fetch(`https://registry.npmjs.org/${encoded}`)
if (!res.ok) {
  console.log(`❌ registry 查询失败：HTTP ${res.status}`)
  process.exit(1)
}
const meta = await res.json()
const latest = meta['dist-tags'].latest
const version = meta.versions[latest]

console.log(`包:      ${meta.name}@${latest}`)
console.log(`runtime: ${runtime}`)
console.log('peerDependencies:')
for (const [name, range] of Object.entries(version.peerDependencies ?? {})) {
  console.log(`  ${name} = ${range}`)
}

// 复现兼容性判定：只检查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 前缀
const incompatible = {}
for (const [name, range] of Object.entries(version.peerDependencies ?? {})) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) {
    console.log(`  · 跳过（不匹配 dsh 前缀判定）：${name}`)
    continue
  }
  const ok = semver.satisfies(runtime, range, { includePrerelease: true })
  console.log(`  ${ok ? '✓' : '✗'} ${name} @ ${range} → satisfies=${ok}`)
  if (!ok) incompatible[name] = range
}

const count = Object.keys(incompatible).length
console.log('')
if (count === 0) {
  console.log('=> ✅ 兼容，不需要版本豁免')
} else {
  console.log(`=> ❌ 有 ${count} 个不兼容 dsh peer ⇒ bundle 会被 SKIP，需要「版本豁免」`)
  console.log(`   豁免键 = ${meta.name}@${latest}  →  runtime ${runtime}`)
  console.log('   依据源码：profile 的「版本豁免」记录由 DSH 插件管理器写入（UI: 允许此版本）')
}
