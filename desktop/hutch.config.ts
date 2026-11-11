// Hutch is Electrobun's build tool. It is downloaded on first use by the `electrobun`
// npm package (a devDependency of the repository root), so there is nothing to install
// globally. Run these through the root package.json: `bun run desktop:dev` / `desktop:build`.
export default {
  // The exact Electrobun release this project is built with. Keep it equal to the
  // `electrobun` version in the root package.json; `hutch electrobun update` bumps it.
  electrobun: { version: '2.0.6' },
  scripts: {
    dev: ['hutch', 'electrobun', 'dev'],
    build: ['hutch', 'electrobun', 'build', '--env=stable'],
  },
};
