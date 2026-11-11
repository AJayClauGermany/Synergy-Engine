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
