import type { ElectrobunConfig } from 'electrobun';

/**
 * Packages the game as a desktop app with Electrobun. The web build in desktop/dist
 * (produced by `bun run desktop:build` from the repository root) is copied into the app
 * bundle and loaded from disk, so the game runs with no network connection.
 *
 * Electrobun builds for the operating system it runs on; build each platform on that
 * platform (or on a matching CI runner).
 */
export default {
  app: {
    // Shown in the title bar, dock/taskbar and installer. Change these for your game.
    name: 'Synergy Skirmish',
    identifier: 'dev.synergy.skirmish',
    version: '0.1.0',
  },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    copy: {
      dist: 'views/game',
    },
    watchIgnore: ['dist/**'],
    // `false` uses the system webview (small download). Set to `true` to ship Chromium
    // with the app when you need identical rendering on every machine.
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
