import { expect, test } from 'bun:test';
import manifest from '../package.json';

// The engine stays small enough to read: PlayCanvas, and nothing else (AGENTS.md,
// "Boundaries"). Whatever a game needs beyond that belongs to the game, or to another
// package that depends on the engine.
test('the engine depends on PlayCanvas and nothing else', () => {
  expect(Object.keys(manifest.dependencies)).toEqual(['playcanvas']);
  expect(Object.keys(manifest)).not.toContain('peerDependencies');
  expect(Object.keys(manifest)).not.toContain('optionalDependencies');
});
