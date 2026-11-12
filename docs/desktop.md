# Desktop builds with Electrobun

`desktop/` wraps the same web build in a native window using
[Electrobun](https://electrobun.dev) 2. The game files ship inside the app and load from
disk, so it runs offline; only online multiplayer needs a connection. That includes the
images, models and sounds: the web deploy keeps those in R2, a desktop build keeps them in
`views/game/assets/` (see [deploying.md](deploying.md), "Assets").

> **Status:** the configuration follows Electrobun 2.0.6's official templates.
> `bun run desktop:dev` has been run once, on macOS (12 November 2026): it downloaded the
> tools and opened the game with no changes. The system asked whether the app may use the
> network, and the download needed a direct connection (no VPN). `bun run desktop:build`,
> Windows and Linux have not been run; please update this note when they are.

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
  WebKitGTK), which keeps the download small. If you need identical rendering
  everywhere, set `bundleCEF: true` in `electrobun.config.ts` to ship Chromium with the app.
- **WebGPU.** The game renders with WebGPU where the webview offers it and falls back to
  WebGL 2 elsewhere (`game/src/main.tsx`; PlayCanvas makes the choice at start-up, and
  `?renderer=webgl2` forces WebGL 2). By webview:

  | Platform | System webview | WebGPU |
  |----------|----------------|--------|
  | Windows | WebView2 (Chromium) | yes |
  | macOS 26 and later | WKWebView | yes |
  | macOS before 26 | WKWebView | no: WebGL 2 |
  | Linux | WebKitGTK | no: WebGL 2 |

  With `bundleCEF: true` the app gets Chromium's WebGPU on Windows and macOS whatever the
  OS version. None of this has been checked in a packaged build yet (see the status note
  above); `synergy.engine.app.graphicsDevice.deviceType` in the window's console says
  which one is running.
- **Electrobun's own GPU and UI features are separate.** Electrobun 2 can also draw
  natively from the Bun main process (WGPU views, and its Warren UI library's GPU
  renderer). The game does not use them: PlayCanvas and the Preact HUD run inside the
  webview, where WebGPU covers the game's rendering.
- **Linux** needs GTK 3 and WebKitGTK 4.1 installed at run time.
- **Electrobun is not Electron.** Main-process APIs come from `electrobun/main`; do not
  reach for Electron or Node `electron` patterns.
- **Versions.** Keep `electrobun` in the root `package.json` and `electrobun.version` in
  `desktop/hutch.config.ts` the same.
- Code signing, auto-updates and installers are covered in Electrobun's own docs.
