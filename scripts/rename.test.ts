import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { checkName, rename, titleOf } from './rename';
import { assetBucket, type WorkerConfig } from './deploy';

const root = path.resolve(import.meta.dir, '..');
const read = (file: string) => Bun.file(path.join(root, file)).text();

describe('bun run rename', () => {
  test('writes the name into every file of the project as it is now', async () => {
    const files: Record<string, string> = {};
    for (const file of [
      'wrangler.jsonc',
      'package.json',
      'game/src/online.ts',
      'game/src/frontier/session.ts',
      'game/index.html',
      'desktop/electrobun.config.ts',
    ]) {
      files[file] = await read(file);
    }
    const renamed = rename(files, { name: 'star-forge', title: "Star Forge: Ada's <Cut>" });

    // The three that must agree, or a deploy looks for a bucket that is not the Worker's.
    const config = Bun.JSONC.parse(renamed['wrangler.jsonc'] ?? '') as WorkerConfig;
    expect(config.name).toBe('star-forge');
    expect(assetBucket(config, 'preview')).toBe('star-forge-assets');
    expect(assetBucket(config, 'production')).toBe('star-forge-assets');

    expect(JSON.parse(renamed['package.json'] ?? '')).toMatchObject({ name: 'star-forge' });
    expect(renamed['game/src/online.ts']).toContain("const PEER_PREFIX = 'star-forge';");
    expect(renamed['game/src/frontier/session.ts']).toContain("const PEER_PREFIX = 'star-forge-frontier';");
    expect(renamed['game/index.html']).toContain("<title>Star Forge: Ada's &lt;Cut></title>");
    expect(renamed['desktop/electrobun.config.ts']).toContain("name: 'Star Forge: Ada\\'s <Cut>',");
    expect(renamed['desktop/electrobun.config.ts']).toContain("identifier: 'dev.synergy.starforge',");

    // Running it again with the same name changes nothing.
    expect(rename(renamed, { name: 'star-forge', title: "Star Forge: Ada's <Cut>" })).toEqual(renamed);
  });

  test('a file that lost the place for its name is reported, not skipped', () => {
    expect(() => rename({ 'wrangler.jsonc': '{}' }, { name: 'x', title: 'X' })).toThrow(
      'wrangler.jsonc: found nothing',
    );
  });

  test('names Cloudflare would refuse are refused first', () => {
    expect(checkName('my-game-2')).toBeNull();
    expect(checkName('My Game')).toContain('lowercase');
    expect(checkName('my--game')).toContain('lowercase');
    expect(checkName('a'.repeat(41))).toContain('40');
    expect(titleOf('my-game-2')).toBe('My Game 2');
  });
});
