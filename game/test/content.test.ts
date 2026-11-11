import { expect, test } from 'bun:test';
import { checkTilemapData, checkTilePaletteData } from '@synergy/engine/data';
import { ARMY, canEnter, map, START_CELLS, terrainAt, tiles, unitTypes } from '../src/frontier/rules';

// One test over every content file the game ships. A wrong tile id or a miscounted row
// fails here, with a sentence saying what is wrong, instead of showing up as a blank tile.
test('the shipped tile palette and map are sound', () => {
  expect(checkTilePaletteData(tiles)).toEqual([]);
  expect(
    checkTilemapData(
      map,
      tiles.tiles.map((tile) => tile.id),
    ),
  ).toEqual([]);
});

test('every terrain tile carries the data the rules read', () => {
  for (const id of map.layers.flatMap((layer) => layer.tiles)) {
    const data = tiles.tiles.find((tile) => tile.id === id)?.data;
    expect(typeof data?.climate, `climate of "${id}"`).toBe('string');
    for (const field of ['elevation', 'moveCost', 'cover'] as const) {
      expect(typeof data?.[field], `${field} of "${id}"`).toBe('number');
    }
  }
});

test('both armies start on ground they can stand on, with unit types that exist', () => {
  for (const type of ARMY) expect(unitTypes.has(type)).toBe(true);
  for (const cells of START_CELLS) {
    expect(cells.length).toBe(ARMY.length);
    for (const cell of cells) {
      expect(terrainAt(cell)).not.toBeNull();
      expect(canEnter(cell)).toBe(true);
    }
  }
});
