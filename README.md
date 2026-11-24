# dsh-annotate

[中文](#中文) | [English](#english)

Annotate frontend elements in DSH's built-in browser and send the feedback straight into the current conversation. The annotation UI is [agentation](https://github.com/benjitaylor/agentation), bundled unmodified.

---

## 中文

### 它做什么

- 在 DSH 桌面端的内置浏览器里点选页面元素、框选区域或选中文字，写下要改什么。
- 点 **Send to Agent**，反馈作为一条用户消息进入**这个浏览器标签所属的对话**。
- 不新建对话，也不启动新的 agent 会话。
- agentation 的源码一行不改；本插件只负责注入、提交桥和 DSH 接线。

### 安装

1. 下载或克隆本仓库。
2. 在 DSH 打开 **插件 → 添加插件**，选择本目录；或执行：

   ```bash
   git clone https://github.com/qijin-3/dsh-annotate.git
   dsh plugin --profile desktop add ./dsh-annotate
   ```

3. 重启 DSH 一次。

`lib/inject.js` 已经预打包好，装好就能批注。只有“检查更新/更新”需要本机重新打包。

### 使用

1. 在右侧栏打开 **Browser**，访问一个本地页面（默认 `localhost`、`127.0.0.1`、`::1`）。
2. 页面右下角出现 agentation 工具条；点它，再点页面元素，写批注。
3. 点 **Send to Agent**。反馈进入该标签所属的当前对话。

### 更新 agentation

打开 **Settings（左侧栏最底部的齿轮，或 `Cmd+,`）→ 网页批注**：

- **检查更新**：读取 `benjitaylor/agentation` 的 GitHub tags 和 npm 已发布版本。
- **更新到 vX**：只在 npm 已发布该版本时出现。下载对应 npm 包，用 esbuild 重新打包 `src/inject.tsx`，原子替换 `lib/inject.js`。
- agentation 的源码不改；只是换掉被 bundle 的依赖。
- 已打开的页面仍是旧实例，刷新后生效。
- 当前版本记录在 `state/agentation.json`（本机状态，不要提交到仓库）。

### 初始化（给其他人）

- **批注核心零初始化**：`lib/inject.js` 已提交，装上就能用。
- **打包安装**（npm 包 / release 的 `.tgz`，推荐）：`esbuild`、`react`、`react-dom` 会由包管理器自动安装。
- **目录 / 源码安装**：包管理器不会替它装依赖。打开 **Settings → 网页批注**，点 **初始化**；或在插件目录执行：

  ```bash
  node scripts/setup.mjs
  ```

  初始化优先用 DSH 自带的 pnpm，其次用系统 npm，只下载约 20 MB 构建依赖，不影响已有批注能力。

### 限制

- **只支持 Desktop 内置浏览器**。Web 端的 Browser 是跨域 iframe，父页面无法注入脚本。
- 默认只对 loopback 页面注入，避免在任意公网站点上弹工具条；需要时在 `cordis.patch.yml` 的 `hosts` 里追加主机名。
- HTTPS 页面提交到本机 HTTP 的 DSH 会被混合内容策略拦截；本地开发服务器建议用 HTTP。
- 页面 CSP 禁止内联 `<style>` 时，工具条外观可能不完整。
- 单页应用的前端路由切换不会重复注入（agentation 自身仍可在同一文档继续批注）。

### 实现

- `lib/index.js`：Host，注册 `/dsh-annotate/*` 路由、签发页面令牌、把批注通过 `ctx.sessionController.prompt` 追加到标签所属 Session。
- `lib/client.js`：Client，监听内置浏览器 `<webview>`、读取标签所属对话、注入脚本、提供设置页。
- `lib/update.js`：Host，检查 GitHub/npm 版本、下载 tarball、esbuild 重建。
- `lib/inject.js`：由 `src/inject.tsx` 打包的 IIFE（React 18 + ReactDOM + agentation + 提交桥）。

Electron 会取消访客页面发往 DSH 自身 Host 的 http/ws 请求，所以访客通过同一端口的 IPv4-mapped IPv6 写法 `[::ffff:127.0.0.1]` 提交；普通地址作为回退。

### 许可证

插件自身代码是 **MIT**（见 `LICENSE`）。

`lib/inject.js` 内包含 **agentation 3.1.2**，使用 **PolyForm Shield 1.0.0**：源码可见，但不是 OSI 开源许可；允许使用，但不允许拿它做与 agentation 竞争的产品。商用或再分发前请先阅读 `THIRD_PARTY_LICENSES/agentation-LICENSE.txt`。React 与 ReactDOM 为 MIT。

---

## English

### What it does

- Click elements, drag a region, or select text in DSH Desktop's built-in browser and write what should change.
- Press **Send to Agent**. The feedback arrives as a user message in **the conversation that owns the browser tab**.
- No new conversation and no separate agent session.
- agentation's source is untouched; this plugin only adds the injection, the submit bridge, and the DSH wiring.

### Install

1. Clone or download this repository.
2. In DSH open **Plugins → Add plugin** and choose this folder, or run:

   ```bash
   git clone https://github.com/qijin-3/dsh-annotate.git
   dsh plugin --profile desktop add ./dsh-annotate
   ```

3. Restart DSH once.

`lib/inject.js` is prebuilt, so annotation works immediately. Only Check / Update needs a local rebuild.

### Use

1. Open **Browser** in the right sidebar and visit a local page (`localhost`, `127.0.0.1`, `::1` by default).
2. The agentation toolbar appears in the page's bottom-right; click it, then click an element and write a note.
3. Press **Send to Agent**. The feedback lands in the current conversation that owns the tab.

### Update agentation

Open **Settings** (the gear at the bottom of the left sidebar, or `Cmd+,`) → **Page annotate**:

- **Check for updates** reads the GitHub tags of `benjitaylor/agentation` and the published npm version.
- **Update to vX** appears only when npm has that version. It downloads the npm package, rebuilds `src/inject.tsx` with esbuild, and atomically replaces `lib/inject.js`.
- agentation's source is never edited; only the bundled dependency changes.
- Open pages keep the old instance until they reload.
- The installed version is recorded in `state/agentation.json` (machine-local; do not commit it).

### Initialization (for other users)

- **Core annotation needs no setup**: the committed `lib/inject.js` is ready to use.
- **Packed install** (npm package / release `.tgz`, recommended): `esbuild`, `react`, and `react-dom` are installed by the package manager.
- **Directory / source install**: the package manager does not install its dependencies. Open **Settings → Page annotate** and press **Set up**, or run in the plugin directory:

  ```bash
  node scripts/setup.mjs
  ```

  It prefers DSH's bundled pnpm, then system npm. It downloads about 20 MB of build dependencies and does not affect annotation itself.

### Limitations

- **Desktop built-in browser only**. The Web browser panel is a cross-origin iframe, and the parent page cannot inject into it.
- Only loopback pages are injected by default, so the toolbar does not appear on arbitrary public sites. Add hostnames under `hosts` in `cordis.patch.yml` if needed.
- An HTTPS page submitting to a local HTTP DSH is blocked by mixed-content rules; prefer HTTP for the local dev server.
- A page CSP that forbids inline `<style>` can leave the toolbar under-styled.
- SPA route changes do not re-inject; agentation itself keeps working within the same document.

### How it works

- `lib/index.js`: Host routes under `/dsh-annotate/*`, page tokens, and `ctx.sessionController.prompt` into the Session that owns the tab.
- `lib/client.js`: watches the built-in browser's `<webview>`, reads the owning conversation, injects the bundle, and renders the settings page.
- `lib/update.js`: GitHub/npm checks, tarball download, and the esbuild rebuild.
- `lib/inject.js`: the IIFE built from `src/inject.tsx` (React 18 + ReactDOM + agentation + submit bridge).

Electron cancels guest requests to DSH's own Host, so the guest submits to the same listener through the IPv4-mapped IPv6 spelling `[::ffff:127.0.0.1]`; the plain address stays as a fallback.

### License

The plugin's own code is **MIT** (see `LICENSE`).

`lib/inject.js` bundles **agentation 3.1.2**, licensed under **PolyForm Shield 1.0.0** — source-available, not OSI open source; it permits use except for competing with agentation. Read `THIRD_PARTY_LICENSES/agentation-LICENSE.txt` before commercial use or redistribution. React and ReactDOM are MIT.
