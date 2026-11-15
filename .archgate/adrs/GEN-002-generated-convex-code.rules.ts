/// <reference path="../rules.d.ts" />

/** What `bun run backend` (convex dev) regenerates `convex/_generated/` from. */
const SOURCES = /^(convex\/(?!_generated\/).+|package\.json|bun\.lock|convex\.json)$/;

export default {
  rules: {
    'generated-code-changes-with-its-sources': {
      description: 'convex/_generated/ changes only in a change that also touches the functions or the convex version',
      async check(ctx) {
        // Needs a change set: on a full scan (no base branch) there is nothing to compare.
        const generated = ctx.changedFiles.filter((file) => file.startsWith('convex/_generated/'));
        if (generated.length === 0 || ctx.changedFiles.some((file) => SOURCES.test(file))) return;
        for (const file of generated) {
          ctx.report.violation({
            message:
              `${file} changed, but no Convex function, package.json or bun.lock did. The folder is written by ` +
              '`convex dev`; an edit by hand is lost the next time it runs, and may not match the deployment.',
            file,
            fix: 'Revert the edit (git checkout origin/main -- convex/_generated) and change convex/*.ts instead; `bun run backend` regenerates the folder.',
          });
        }
      },
    },
  },
} satisfies RuleSet;
