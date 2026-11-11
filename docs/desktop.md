# Desktop builds with Electrobun

`desktop/` wraps the same web build in a native window using
[Electrobun](https://electrobun.dev) 2. The game files ship inside the app and load from
disk, so it runs offline; only online multiplayer needs a connection.

> **Status:** the configuration follows Electrobun 2.0.6's official templates, but it
> could not be built in the environment this template was authored in (its toolchain
> download host was blocked there). Expect to adjust it on first use, and please update
> this note once it is confirmed on your machine.

## Commands

Run in a desktop window, using the dev server (`bun run dev`) if it is running so that
edits hot-reload:

```bash
bun run desktop:dev
```

Build a distributable app into `desktop/artifacts/`:

```bash
bun run desktop:build
```

Both first build the game into `desktop/dist/`. The first run downloads Electrobun's
build tool (Hutch) and SDK, which needs network access.

## What is where

| File | Purpose |
|------|---------|
| `desktop/electrobun.config.ts` | App name, identifier, version; what gets bundled |
| `desktop/hutch.config.ts` | Pins the Electrobun version |
| `desktop/src/bun/index.ts` | The main process: opens the window |
| `desktop/dist/` | Generated web build (git-ignored) |

## Things to know

- **One platform per build.** Electrobun builds for the OS it runs on. Produce Windows,
  macOS and Linux builds on those systems or on matching CI runners.
- **Webview.** By default the app uses the system webview (WKWebView, WebView2,
  WebKitGTK), which keeps the download small. The game needs WebGL 2. If you need
  identical rendering everywhere, set `bundleCEF: true` in `electrobun.config.ts` to ship
  Chromium with the app.
- **Linux** needs GTK 3 and WebKitGTK 4.1 installed at run time.
- **Electrobun is not Electron.** Main-process APIs come from `electrobun/main`; do not
  reach for Electron or Node `electron` patterns.
- **Versions.** Keep `electrobun` in the root `package.json` and `electrobun.version` in
  `desktop/hutch.config.ts` the same.
- Code signing, auto-updates and installers are covered in Electrobun's own docs.
