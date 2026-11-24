# dsh-annotate

Annotate frontend elements in DSH's built-in browser and send the feedback into the current conversation.

The annotation UI is [agentation](https://github.com/benjitaylor/agentation) `3.1.2`, bundled **unmodified**. This plugin only adds a submit bridge and the DSH wiring around it, so agentation stays upstream-maintainable.

- Works with the Desktop built-in browser (Electron `<webview>`); the Web iframe carrier cannot be scripted cross-origin.
- Injects only on loopback hosts by default (`localhost`, `127.0.0.1`, `::1`, `*.localhost`).
- Sends each batch through `ctx.sessionController.prompt` into the Session that owns the Browser tab. It never calls `session.create` and never starts a separate conversation.
- Tokens are minted per page load for that Session and page origin; the Host route is token-gated.
- The Electron guest may not request the DSH Host directly (its session cancels such requests), so the guest submits to the same listener through the IPv4-mapped IPv6 spelling `[::ffff:127.0.0.1]`; the wrapper also keeps the plain route as a fallback.

## Where the settings are

Open **Settings** from the gear at the **bottom of the left sidebar** (or `Cmd+,`), then pick **网页批注 / Page annotate** in the left navigation.

## Update agentation

**Settings → 网页批注 (Page annotate)** shows the bundled version and offers **Check for updates** / **Update to vX**.

- The check reads the repo's GitHub tags and the npm registry. A tag that npm has not published is reported as not installable.
- The update downloads that npm release, rebuilds `src/inject.tsx` with esbuild, and atomically replaces `lib/inject.js`. agentation's source is never edited.
- The installed version is recorded in `state/agentation.json`. Open pages keep the previous instance until they reload.
- Building at runtime needs `esbuild`, `react`, and `react-dom` in the plugin's own `node_modules` (declared as dependencies).
- A packed/npm install gets them automatically. A linked directory does not: open Settings → 网页批注 and press **初始化**, or run `node scripts/setup.mjs`. The core annotation needs no setup.

> This version adds Host routes and the settings card. Restart DSH once after installing it so the new Host half and Settings section load.

## Install

1. Clone or download this repository.
2. In DSH open **Plugins → Add plugin** and choose the folder, or run:

   ```bash
   git clone https://github.com/qijin-3/dsh-annotate.git
   dsh plugin --profile desktop add ./dsh-annotate
   ```

3. Restart DSH once.

The prebuilt `lib/inject.js` is committed, so annotation works right away. The update button needs the small build toolchain; see the initialization note above.

## Build

```bash
npm install --cache ./.npm-cache
npm run build
```

`lib/inject.js` is committed so the installed plugin needs no build step. The settings card can rebuild it later when agentation publishes a new version.

## Layout

| File | Role |
| --- | --- |
| `lib/index.js` | Host: token minting, submit route, prompt admission, update routes |
| `lib/update.js` | Host: GitHub/npm version check, tarball download, esbuild rebuild |
| `lib/client.js` | Client: webview watcher, session binding, injection, settings card |
| `src/inject.tsx` | Injected wrapper around agentation |
| `scripts/build-inject.mjs` | esbuild bundle for `lib/inject.js` |

## License

The plugin's own code is **MIT** (see `LICENSE`).

`lib/inject.js` is a prebuilt bundle that contains **agentation 3.1.2**, licensed under **PolyForm Shield 1.0.0** — source-available, not OSI open source. It permits use except for competing with agentation; review it before commercial redistribution. React and ReactDOM are MIT. Full texts are in `THIRD_PARTY_LICENSES/`.
