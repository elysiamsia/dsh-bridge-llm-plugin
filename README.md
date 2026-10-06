# dsh-bridge 的两个 DSH 原生插件

把本地 [dsh-bridge](https://github.com/elysiamsia/dsh-bridge)（Python + Playwright 驱动
4 站**网页版** AI：DeepSeek / 豆包 / 智谱 / 通义千问）以 **DSH 原生插件**形式接入
DeepSeek Harness。

**业务逻辑只有一份**（现有 Python 实现）；插件只做「原生接入外壳」，通过 MCP stdio
子进程复用已过 469 条测试的 Python 内核 —— **不重写 Playwright / stealth / fallback /
登录 / G20 频控**。

| 包 | inject | 提供什么 |
|---|---|---|
| **`dsh-bridge-plugin`** | `['tools']` | 原生工具 `ask_deepseek`、诊断探针 `dsh_bridge_probe` |
| **`dsh-bridge-llm-plugin`** | `['llm']` | LLM provider `deepseek-web` —— DSH 的模型可用你**已登录的 deepseek 网页会话** |

> 分成两个包是**刻意的**：任一插件出问题只影响自己的 fiber，不会把另一个拖下水。

---

## 别人怎么装（三种方式，对应 DSH 「设置 → 插件 → 添加插件」）

DSH 的添加插件输入框接受 **npm 包名 / GitHub 仓库地址 / 本地目录路径** 三种。

### 方式 1：本地目录路径（今天就能用）

前提：本机已有这两个插件目录（如从仓库 clone 下来）+ 已装 `dsh-bridge` 本体。

在「添加插件」里分别填入：

```
D:\claude-code\dsh-bridge-plugin
D:\claude-code\dsh-bridge-llm-plugin
```

或直接用附带的统一安装脚本（离线、等价于逐条 `dsh plugin add`）：

```powershell
powershell -ExecutionPolicy Bypass -File install-all-plugins.ps1
# 卸载：
powershell -ExecutionPolicy Bypass -File install-all-plugins.ps1 -Uninstall
```

### 方式 2：GitHub 仓库地址

把本目录推到 GitHub 后，在「添加插件」里填仓库地址，例如：

```
https://github.com/<你的账号>/dsh-bridge-plugin
https://github.com/<你的账号>/dsh-bridge-llm-plugin
```

### 方式 3：npm 包名（发布后）

```powershell
cd dsh-bridge-plugin      && npm publish --access public
cd ..\dsh-bridge-llm-plugin && npm publish --access public
```

发布后别人在「添加插件」里填包名即可：`dsh-bridge-plugin` / `dsh-bridge-llm-plugin`。

> 注意：包名在 npm 上必须唯一。若已被占用，改用 scope，如 `@你的名字/dsh-bridge-plugin`
> （同时要改 `package.json` 的 `name`、以及各自 `cordis.patch.yml` 里 loader 行的 `name`）。

---

## 前置条件（别人的机器上也要有）

1. **DSH Desktop**（本插件针对 `@deepseek-ai/dsh-desktop 0.2.0-rc.2` 实测）
2. **Node.js ≥ 20**（宿主自带 Node，无需单独装）
3. **Python ≥ 3.11 + uv**：插件的 `command`/`args` 默认是
   `uv run --directory <dsh-bridge 路径> dsh-bridge`
4. **dsh-bridge 本体**（Python 侧）已就位并能跑：
   ```powershell
   uv run --no-sync dsh-verify readiness
   ```
5. **站点登录态**：真站调用前先续期（否则被 G20 拦）
   ```powershell
   uv run --no-sync dsh-login deepseek
   ```

配置项（`command`/`args`/`cwd`/超时/provider 名等）在两个包各自的 `cordis.patch.yml`
里，改动后**完全退出并重启** DSH Desktop 才生效（关窗口可能只是最小化到托盘）。

---

## ⚠️ 两条必须知道的硬约束

### 1. G20 频控铁律（**最高优先级**）

- 每跑 1 次真站冒烟 = **4 个站点账号同时吊销**
- 真站访问只允许 **deepseek**，且 `verify ≥ 6.0h`
- **dsh-bridge 的 `ask` 路径本身不检查 G20**（源码确认），所以**两个插件都内置了
  G20 前置闸门**：调用前先用 `route_task`（纯逻辑、不起浏览器、不 send）读
  `verify_status`，冻结/陈旧就**拒绝**并提示你跑 `dsh-login`
- 预检本身失败时**保守拒绝**（宁可拒绝，也不冒误发风险）

### 2. 网页版聊天没有结构化工具调用

`deepseek-web` 这个 provider **只能纯对话**：网页 UI 给不出 `tool-call`，
所以挂上它以后模型**无法调用任何工具**（不能跑 agent 循环）。
这是网页版的固有边界，不是实现缺陷。

---

## 排障

插件自带**面包屑日志**（沿用工具插件验证过的诊断技法）：

```
dsh-bridge-plugin\diag\boot.log
dsh-bridge-llm-plugin\diag\boot.log
```

日志记录：导入期 → apply 入口（含 `ctx` 真实形状）→ 每一步 → 每个异常（完整栈）。
**即使插件页只显示「异常」而不给原因，也能从这两个文件读到确切失败点。**

宿主崩溃日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`

### 已知陷阱（改代码前必读）

| 陷阱 | 说明 |
|---|---|
| profile 的 `package.json` **绝不能带 UTF-8 BOM** | 宿主启动时直接 `JSON.parse`，BOM 会 `DesktopHostFatalError` 崩溃。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，必须用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` |
| 含中文的 `.ps1` **必须有** BOM | PS 5.1 无 BOM 时按 GBK 解码中文 → 语法错。与上一条**方向相反** |
| `lib/index.js` 必须是**纯 ESM JS** | 宿主直接 import，不经转译；写 TS 类型语法会 SyntaxError |
| **不要 `import '@deepseek-ai/dsh-tools'`** | 本机 profile 里解析不到（junction 指向已消失的 npx 缓存）。工具定义请**直接写标准 JSON Schema**（`required` 是**字符串数组**，不是 DSH 方言的 `required: true`） |
| LLM adapter **不要继承 `LlmAdapter`** | `registerAdapter()` 不做 `instanceof` 检查，**鸭子类型即可**；但要实现基类**全部 7 个方法**（缺一个就是 `undefined` → TypeError） |
| `file://` URL | Node 的 `import()` 在 Windows 上不接受裸 `C:/...` 路径 |
