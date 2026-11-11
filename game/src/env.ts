/**
 * Build-time configuration. Bun replaces `process.env.PUBLIC_*` with the value from the
 * environment when the variable is set; the scripts load it from `.env.schema` and
 * `.env.local` through varlock (docs/environment.md). When it is not set the
 * expression is left as-is, and `process` does not exist in a browser, hence the guard.
 *
 * Only `PUBLIC_` variables reach the browser. Anything else stays on your machine.
 */
function read(get: () => string | undefined): string | undefined {
  try {
    return get() || undefined;
  } catch {
    return undefined;
  }
}

/** URL of the Convex deployment, e.g. https://happy-animal-123.convex.cloud. Optional. */
export const convexUrl = read(() => process.env.PUBLIC_CONVEX_URL);

/**
 * Identifies this build of the game. `bun run build` sets it to a hash of the source, so
 * two machines agree on it exactly when they run the same code; under `bun run dev` it
 * is "dev". Give it to netcode as `networkConfig.protocolVersion`, which stops players on
 * different builds from joining each other.
 */
export const buildId = read(() => process.env.PUBLIC_BUILD_ID) ?? 'dev';
