# 统一安装 dsh-bridge 的两个 DSH 原生插件到本地 profile。
#
#   · dsh-bridge-plugin       —— 原生工具（ask_deepseek / dsh_bridge_probe），inject: ['tools']
#   · dsh-bridge-llm-plugin   —— LLM adapter（deepseek 网页登录态），inject: ['llm']
#
# 分成两个包是刻意的：任一插件出问题只影响它自己的 fiber，不会把另一个拖下水。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-all-plugins.ps1
#   powershell -ExecutionPolicy Bypass -File install-all-plugins.ps1 -Uninstall
#
# ⚠️ 两个必须遵守的编码细节（都踩过坑）：
#   ① 写 profile 的 package.json **绝不能带 BOM** —— 宿主启动时 JSON.parse 会崩。
#   ② 本脚本自己**必须带 UTF-8 BOM** —— PowerShell 5.1 无 BOM 时会按 GBK 解码中文，
#      导致语法错误。（写入方是编辑工具，故运行时不必处理，但别手工去掉 BOM。）

param(
  [string]$Profile = 'desktop',
  # 🌸 源码目录默认按「两个仓库同级」推导；布局不同时用这两个参数覆盖。
  [string]$ToolsPlugin = '',
  [string]$LlmPlugin = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# 插件清单：包名 -> 源码目录。
#
# 🌸 不写死任何机器专属路径：默认假定两个插件仓库是**同级目录**
#    （即 clone 到同一个父目录下）。若布局不同，用参数显式覆盖：
#      -ToolsPlugin <路径>  /  -LlmPlugin <路径>
$plugins = [ordered]@{
  'dsh-bridge-plugin'     = if ($ToolsPlugin) { $ToolsPlugin } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'dsh-bridge-plugin' }
  'dsh-bridge-llm-plugin' = if ($LlmPlugin)   { $LlmPlugin }   else { $PSScriptRoot }
}

function Write-JsonNoBom {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Json)
  [System.IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

# 把当前 $manifest 写回 profile（无 BOM）。$manifest / $manifestPath 是脚本级变量，
# 函数内可直接读取（PowerShell 动态作用域）。
function Write-ManifestNoBom {
  Write-JsonNoBom -Path $manifestPath -Json ($manifest | ConvertTo-Json -Depth 32)
}

function Assert-JsonParses {
  param([Parameter(Mandatory)][string]$Path)
  # 复现宿主的 readProfileManifest：直接 JSON.parse，先验 BOM
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "profile 清单带 BOM，宿主启动会崩：$Path"
  }
  $null = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
}

$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "DSH profile not found: $manifestPath" }

# 先确认所有源码目录都在，避免装一半
foreach ($entry in $plugins.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath (Join-Path $entry.Value 'package.json'))) {
    throw "插件源码缺失：$($entry.Value)（缺 package.json）"
  }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

# ────────────────────────────── 卸载 ──────────────────────────────
if ($Uninstall) {
  foreach ($pkgName in $plugins.Keys) {
    if (@($manifest.dependencies.PSObject.Properties.Name) -contains $pkgName) {
      $manifest.dependencies.PSObject.Properties.Remove($pkgName)
    }
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
    $dir = Join-Path $profileDir "node_modules\$pkgName"
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Write-Output "已移除 $pkgName"
  }
  Write-ManifestNoBom
  Assert-JsonParses $manifestPath
  Write-Output '卸载完成。请完全退出并重启 DeepSeek Harness Desktop。'
  return
}

# ────────────────────────────── 安装 ──────────────────────────────
$backup = "$manifestPath.bak-dsh-bridge-plugins"
Copy-Item -LiteralPath $manifestPath -Destination $backup -Force
Write-Output "已备份 profile 清单 -> $backup"

foreach ($entry in $plugins.GetEnumerator()) {
  $pkgName = $entry.Key
  $source = $entry.Value

  # 1. 登记 dependencies（link: 指向源码目录）+ bundles
  if (-not (@($manifest.dependencies.PSObject.Properties.Name) -contains $pkgName)) {
    $manifest.dependencies | Add-Member -NotePropertyName $pkgName `
      -NotePropertyValue ("link:" + ($source -replace '\\', '/')) -Force
  } else {
    $manifest.dependencies.$pkgName = "link:" + ($source -replace '\\', '/')
  }
  if (-not ($manifest.dsh.profile.bundles -contains $pkgName)) {
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + @($pkgName)
  }

  # 2. 复制运行所需文件到 node_modules
  $target = Join-Path $profileDir "node_modules\$pkgName"
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  foreach ($item in @('lib', 'package.json', 'cordis.patch.yml')) {
    $from = Join-Path $source $item
    if (-not (Test-Path -LiteralPath $from)) { throw "缺必需文件：$from" }
    Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
  }

  # 3. 静态自检 + 真实 import 验证（file:// URL —— 裸 Windows 路径会被 Node 拒绝）
  $installed = Get-Content -LiteralPath (Join-Path $target 'package.json') -Raw | ConvertFrom-Json
  if ($installed.name -ne $pkgName) { throw "包名不符：$($installed.name) != $pkgName" }
  if ($installed.dsh.bundle.patch -ne './cordis.patch.yml') { throw "$pkgName 未正确声明 dsh.bundle.patch" }

  $entryUrl = 'file:///' + ($target -replace '\\', '/') + '/lib/index.js'
  $probe = @"
import('$entryUrl').then(m => {
  if (typeof m.apply !== 'function') { console.error('NO_APPLY'); process.exit(1) }
  if (!m.Config) { console.error('NO_CONFIG'); process.exit(1) }
  console.log('  IMPORT_OK ' + m.name + ' inject=' + JSON.stringify(m.inject))
}).catch(e => { console.error('IMPORT_FAILED: ' + e.message); process.exit(1) })
"@
  Write-Output "[$pkgName] 安装到 $target"
  $probe | node --input-type=module
  if ($LASTEXITCODE -ne 0) { throw "$pkgName 安装后 import 验证失败" }
}

# 4. 写回清单（无 BOM）并复现宿主解析
Write-ManifestNoBom
Assert-JsonParses $manifestPath

Write-Output ''
Write-Output '✅ 两个插件均安装完成，且 profile 清单可被宿主正常解析（无 BOM、JSON.parse 通过）'
Write-Output '   现在**完全退出**并重启 DeepSeek Harness Desktop（关窗口可能只是最小化到托盘）。'
Write-Output '   重启后应能看到：原生工具 ask_deepseek / dsh_bridge_probe，以及模型 provider deepseek-web。'
