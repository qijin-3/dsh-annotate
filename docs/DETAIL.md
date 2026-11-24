# 网页批注：把内置浏览器里的前端反馈发回当前对话

**在内置浏览器里点选元素、写批注，把结构化反馈直接发进当前对话，让 agent 照着改。**

1. **自动就位** — 用右侧栏 Browser 打开一个本地页面（`localhost` / `127.0.0.1` / `::1`），agentation 工具条自动出现在页面右下角。
2. **点选批注** — 点工具条激活，再点页面元素、框选区域或选中文字，写下要改什么。选择器、类名、位置和页面上下文由 agentation 采集。
3. **发回当前对话** — 点 **Send to Agent**，反馈作为一条用户消息进入**这个 Browser 标签所属的对话**。不会新建对话，也不会启动新的 agent 会话。
4. **继续改** — agent 在同一个对话里读批注、找代码、改前端；改完刷新页面，工具条随新文档重新注入。

## 更新 agentation

入口在 DSH 主窗口**最左侧栏的底部**：齿轮/账号那一排的 Settings（也可以试 `Cmd+,`）；打开后左侧导航最下面有 **网页批注**。

- **检查更新**：读 GitHub 仓库的 tags（`benjitaylor/agentation`）和 npm 上已发布的版本。GitHub 有 tag、npm 还没发布时，会显示“上游有 vX，但 npm 还没发布”，不会假装能装。
- **更新到 vX**：只在该版本已发布到 npm 时出现。它下载对应 npm 包的 `dist/index.mjs`，用 esbuild 重新打包 `src/inject.tsx`，再原子替换 `lib/inject.js`。
- agentation 的源码不改；更新只是换掉被 bundle 的依赖。已打开的页面仍是旧实例，刷新后生效。
- 版本记录在 `state/agentation.json`，当前版本显示在设置页。

## 初始化（给别人用的安装方式）

**批注本身零初始化。** `lib/inject.js` 已经打包好，装上插件就能用。

只有“检查更新 / 更新”需要在本机重新打包，也就需要 `esbuild`、`react`、`react-dom`：

- **打包安装**（npm 包 / GitHub release 的 `.tgz`，推荐）：`dependencies` 会由包管理器自动安装，开箱即用。
- **目录/源码安装**（`link:`）：包管理器不会替它装依赖。打开 **Settings → 网页批注**，如果显示“缺少构建依赖”，点 **初始化**；它优先用 DSH 自带的 pnpm，其次用系统 npm。也可以在插件目录执行：
  ```bash
  node scripts/setup.mjs
  ```
- 初始化只下载约 20 MB 的构建依赖，不影响插件已有的批注能力。
- 版本状态写在 `state/agentation.json`，是本机状态，不要提交到仓库。

## 常驻与内存

- **DSH 客户端半边**：启动时加载一个约 25 KB 的模块，持有一个 `MutationObserver` 和每个内置浏览器 `<webview>` 的 `dom-ready` 监听。它不做轮询、不跑计时器，内存占用在 KB 级。
- **注入的 agentation**：只存在于被批注页面的文档里。页面导航或关闭时随文档释放。脚本约 590 KB（含 React 18、ReactDOM、agentation），加上运行时 JS 堆通常是几 MB 量级，按“当前打开的被批注页面数”计。
- **Host 半边**：只在请求时读一次 `lib/inject.js` 并发送，不把页面代码常驻在 Host 进程里。
- 默认只对 loopback 页面注入，不会给每个网页都挂一份。自动注入关掉后（如需要可加开关），已注入的页面刷新才会移除。

## 使用前提

- **Desktop 的内置浏览器**。桌面端用 Electron `<webview>` 承载页面，插件通过 `webview.executeJavaScript` 把 agentation 注入访客页面。Web 端的 Browser 是跨域 iframe，页面脚本无法从父页面注入，因此 Web 形态下不会生效。
- **页面必须是本地地址**。默认只对 loopback 主机注入（`localhost`、`127.0.0.1`、`::1`、`*.localhost`），避免在任意公网站点上弹出工具条。需要时在 `cordis.patch.yml` 的 `hosts` 里追加主机名。
- **页面本身不要已经装了 agentation**。检测到已有实例时会跳过注入，避免出现两条工具条。
- 安装/更新插件后，刷新一次被批注的页面，让访客页面拿到新令牌。

## 边界

- 注入脚本在页面自己的上下文里运行：页面 CSP 禁止内联 `<style>` 时，agentation 的外观可能不完整。
- HTTPS 页面向本机 HTTP 的 DSH 提交会被浏览器的混合内容策略拦截；本地开发服务器建议用 HTTP。
- 批注以纯文本消息进入对话，模型看到的是 agentation 的 Markdown 输出；插件不读取宿主的 DOM 结构，也不修改 agentation 的源码。
- 只对**注入时页面文档**生效；单页应用的前端路由切换不会重复注入（agentation 自身仍可在同一文档内继续批注）。
- 自动更新需要插件目录里存在构建依赖（`esbuild`、`react`、`react-dom`）。目录方式安装时先在插件目录执行一次 `npm install`；打包安装由包管理器安装这些依赖。

## 实现要点

- `lib/index.js` — Host：注册 `/dsh-annotate/*` 路由，签发绑定 Session 与页面 origin 的短期令牌，通过 `ctx.sessionController.prompt` 把批注作为用户消息追加到标签所属的 Session。
- `lib/update.js` — Host：GitHub tags / npm 版本检查，下载 tarball，esbuild 重建，原子替换 `lib/inject.js`。
- `lib/client.js` — Client：观察内置浏览器的 `<webview>`，读取标签所属对话；同时注册 **Settings → 网页批注** 的检查/更新卡片。
- `lib/inject.js` — 由 `src/inject.tsx` 打包：React 18 + ReactDOM + 未经修改的 `agentation@3.1.2` + 提交桥。重建用 `npm run build`。

### 为什么要用 `[::ffff:127.0.0.1]`

内置浏览器在 Electron 主进程里安装了一条访客会话策略：**取消所有发往 DSH 自身 Host 的 http/ws 请求**（按 hostname + 端口匹配 `host`、`localhost`、`127.0.0.1`、`[::1]`）。直接 `fetch('http://127.0.0.1:50937/...')` 在访客页面里永远到不了服务端。

插件把提交地址改写为同一端口的 IPv4-mapped IPv6 写法 `http://[::ffff:127.0.0.1]:50937/...`：TCP 仍然落到同一个监听端口，但 hostname 不再命中拦截列表。提交桥同时保留普通地址作为回退，Web/远程部署仍可走普通地址。
