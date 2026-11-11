import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CellLayout,
  CellSwizzle,
  Color,
  createTilemaps,
  Engine,
  Grid,
  type Texture,
  type Tile,
  Tilemap,
  TilemapRenderer,
  TilePalette,
  tilemapsToData,
} from '../src';
// The pure half is imported the way game rules import it: no engine comes with it.
import {
  Catalog,
  checkTilemapData,
  checkTilePaletteData,
  encodeLayer,
  layerCells,
  layerTileAt,
  type TilemapData,
  type TilePaletteData,
} from '../src/data';

interface Terrain {
  climate: 'temperate' | 'arid' | 'polar';
  elevation: number;
  moveCost: number;
}

/** What a Unity export of three Tile assets on one sheet looks like. */
const PALETTE: TilePaletteData<Terrain> = {
  sheets: {
    terrain: {
      image: 'terrain.png',
      pixelsPerUnit: 64,
      sprites: {
        grass_0: { x: 0, y: 0, width: 64, height: 64 },
        sand_0: { x: 64, y: 0, width: 64, height: 64, pivot: [0.5, 0] },
      },
    },
    props: { image: 'props.png', columns: 4, rows: 2 },
  },
  tiles: [
    { id: 'grass', sprite: 'terrain/grass_0', data: { climate: 'temperate', elevation: 1, moveCost: 1 } },
    { id: 'sand', sprite: 'terrain/sand_0', color: '#ffeecc', data: { climate: 'arid', elevation: 0, moveCost: 2 } },
    { id: 'ice', color: '#cfe8ff80', data: { climate: 'polar', elevation: 2, moveCost: 3 } },
    { id: 'rock', sprite: 'props/5', data: { climate: 'temperate', elevation: 3, moveCost: 9 } },
  ],
};

const MAP: TilemapData = {
  grid: { cellLayout: 'hexagon', cellSwizzle: 'xzy', cellSize: [1, 1.1547, 1], cellGap: [0.05, 0.05, 0] },
  layers: [
    // 3 x 2 starting at (-1, 4):   row 4: grass sand grass   row 5: (empty) ice sand
    {
      name: 'Terrain',
      tiles: ['grass', 'sand', 'ice'],
      origin: [-1, 4],
      width: 3,
      height: 2,
      cells: [0, 1, 0, -1, 2, 1],
    },
    {
      name: 'Fog',
      sortingOrder: 2,
      color: '#ffffff80',
      tiles: ['ice'],
      origin: [0, 4],
      width: 1,
      height: 1,
      cells: [0],
    },
  ],
};

describe('Catalog', () => {
  interface UnitType {
    id: string;
    hp: number;
  }
  const units = new Catalog<UnitType>('unit type', [
    { id: 'footman', hp: 10 },
    { id: 'scout', hp: 6 },
  ]);

  test('looks definitions up by id', () => {
    expect(units.get('scout').hp).toBe(6);
    expect(units.has('footman')).toBe(true);
    expect(units.find('dragon')).toBeNull();
    expect(units.ids).toEqual(['footman', 'scout']);
    expect([...units].map((unit) => unit.hp)).toEqual([10, 6]);
    expect(units.size).toBe(2);
  });

  test('a missing id says what exists and what was probably meant', () => {
    expect(() => units.get('scuot')).toThrow(
      'There is no unit type "scuot". Did you mean "scout"? Known unit types: footman, scout.',
    );
    expect(() => units.get('dragon')).toThrow('There is no unit type "dragon". Known unit types: footman, scout.');
    expect(() => new Catalog('weapon').get('bow')).toThrow('Known weapons: (none).');
  });

  test('definitions are read-only, so one unit cannot change the numbers for all of them', () => {
    const types = new Catalog('unit type', [{ id: 'tank', hp: 20, tags: ['armoured'], weapon: { damage: 5 } }]);
    const tank = types.get('tank');
    expect(() => {
      tank.hp = 1;
    }).toThrow();
    expect(() => tank.tags.push('fast')).toThrow();
    expect(() => {
      tank.weapon.damage = 99;
    }).toThrow();
    // A copy is yours to change.
    const mine = { ...tank, hp: 12 };
    expect(mine.hp).toBe(12);
    expect(types.get('tank').hp).toBe(20);

    // Frozen on the outside only (as `Object.freeze` leaves things) is frozen all the way in here.
    const shallow = Object.freeze({ id: 'jeep', weapon: { damage: 2 } });
    const jeep = new Catalog('unit type', [shallow]).get('jeep');
    expect(() => {
      jeep.weapon.damage = 50;
    }).toThrow();
    // Data that refers to itself does not send it round in circles.
    const loop: { id: string; self?: unknown } = { id: 'loop' };
    loop.self = loop;
    expect(new Catalog('thing', [loop]).get('loop').id).toBe('loop');
  });

  test('duplicate and missing ids are refused when the catalog is made', () => {
    expect(() => new Catalog('unit type', [{ id: 'a' }, { id: 'a' }])).toThrow('Two unit types share the id "a"');
    expect(() => new Catalog('unit type', [{ id: '' }])).toThrow('Every unit type needs an "id"');
  });
});

describe('tile data', () => {
  test('a layer is read cell by cell, and outside it there is nothing', () => {
    const terrain = MAP.layers[0];
    if (!terrain) throw new Error('no layer');
    expect(layerTileAt(terrain, { x: -1, y: 4 })).toBe('grass');
    expect(layerTileAt(terrain, { x: 0, y: 5 })).toBe('ice');
    expect(layerTileAt(terrain, { x: -1, y: 5 })).toBeNull(); // empty
    expect(layerTileAt(terrain, { x: 2, y: 4 })).toBeNull(); // outside
    expect(layerTileAt(terrain, { x: 0, y: 4, z: 1 })).toBeNull(); // another z
    expect(layerCells(terrain)).toEqual([
      { x: -1, y: 4, z: 0, tile: 'grass' },
      { x: 0, y: 4, z: 0, tile: 'sand' },
      { x: 1, y: 4, z: 0, tile: 'grass' },
      { x: 0, y: 5, z: 0, tile: 'ice' },
      { x: 1, y: 5, z: 0, tile: 'sand' },
    ]);
  });

  test('cells pack into a layer and come back out the same', () => {
    const cells = [
      { x: 5, y: -2, tile: 'sand' },
      { x: 3, y: 0, tile: 'grass' },
      { x: 4, y: -1, tile: 'sand' },
    ];
    const layer = encodeLayer('Roads', cells, { sortingOrder: 1 });
    expect(layer).toEqual({
      name: 'Roads',
      sortingOrder: 1,
      tiles: ['sand', 'grass'],
      origin: [3, -2],
      width: 3,
      height: 3,
      cells: [-1, -1, 0, -1, 0, -1, 1, -1, -1],
    });
    const back = layerCells(layer).map(({ x, y, tile }) => ({ x, y, tile }));
    expect(back).toEqual([cells[0], cells[2], cells[1]] as typeof cells);
    expect(encodeLayer('Empty', [])).toEqual({
      name: 'Empty',
      tiles: [],
      origin: [0, 0],
      width: 0,
      height: 0,
      cells: [],
    });
    expect(() =>
      encodeLayer('Mixed', [
        { x: 0, y: 0, tile: 'a' },
        { x: 0, y: 0, z: 1, tile: 'a' },
      ]),
    ).toThrow('mixes cells');
  });

  test('sound data passes the checks', () => {
    expect(checkTilePaletteData(PALETTE)).toEqual([]);
    expect(
      checkTilemapData(
        MAP,
        PALETTE.tiles.map((tile) => tile.id),
      ),
    ).toEqual([]);
  });

  test('every mistake in a map is reported in one go', () => {
    const broken: TilemapData = {
      grid: { cellLayout: 'isometric', cellSwizzle: 'abc', cellSize: [1, 1, 1] },
      layers: [
        { name: 'Terrain', tiles: ['grass', 'lava'], origin: [0, 0], width: 2, height: 2, cells: [0, 1, 0] },
        { name: 'Terrain', tiles: ['grass'], origin: [0, 0], width: 1, height: 1, cells: [4] },
      ],
    };
    expect(checkTilemapData(broken, ['grass'])).toEqual([
      'grid.cellLayout is "isometric"; only "rectangle" and "hexagon" are supported.',
      'grid.cellSwizzle is "abc"; expected one of xyz, xzy, yxz, yzx, zxy, zyx.',
      'Layer "Terrain": has 3 cells, but 2 x 2 needs 4.',
      'Two layers are named "Terrain".',
      'Layer "Terrain": a cell holds 4, which is not -1 (empty) or an index into its 1 tiles.',
    ]);
    const unknown: TilemapData = {
      ...MAP,
      layers: [{ ...(MAP.layers[0] as TilemapData['layers'][number]), tiles: ['grass', 'lava', 'ice'] }],
    };
    expect(checkTilemapData(unknown, ['grass', 'ice'])).toEqual([
      'Layer "Terrain": uses tiles the palette does not define: lava.',
    ]);
  });

  test('every mistake in a palette is reported in one go', () => {
    const broken: TilePaletteData = {
      sheets: {
        terrain: { image: 'terrain.png', sprites: { grass_0: { x: 0, y: 0, width: 8, height: 8 } } },
        grid: { image: 'g.png', columns: 2, rows: 2 },
      },
      tiles: [
        { id: 'grass', sprite: 'terrain/grass_0' },
        { id: 'grass', sprite: 'terrain/grass_9' },
        { id: 'mud', sprite: 'swamp/mud_0', color: 'brown' },
        { id: 'cliff', sprite: 'grid/4' },
        { id: 'whole', sprite: 'terrain' },
      ],
    };
    expect(checkTilePaletteData(broken)).toEqual([
      'Two tiles share the id "grass".',
      'Tile "grass": sheet "terrain" has no sprite "grass_9".',
      'Tile "mud": color "brown" is not \'#rrggbb\' or \'#rrggbbaa\'.',
      'Tile "mud": sprite "swamp/mud_0" names the sheet "swamp", which the palette does not have.',
      'Tile "cliff": sheet "grid" has no sprite "4".',
    ]);
  });
});

describe('TilePalette and maps from data', () => {
  let engine: Engine;
  beforeEach(() => {
    engine = Engine.createHeadless();
  });
  afterEach(() => {
    engine.dispose();
  });

  // Stands in for a loaded image: only its size matters to sprites.
  const texture = (width: number, height: number) => ({ width, height }) as unknown as Texture;

  test('each definition becomes a Tile carrying its id, colour, sprite and data', () => {
    const palette = TilePalette.create(PALETTE, { terrain: texture(128, 64), props: texture(256, 128) });
    expect(palette.ids).toEqual(['grass', 'sand', 'ice', 'rock']);

    const sand = palette.get('sand');
    expect(sand.name).toBe('sand');
    expect(sand.data).toEqual({ climate: 'arid', elevation: 0, moveCost: 2 });
    expect(sand.color.equals(Color.fromHex('#ffeecc'))).toBe(true);
    expect(sand.sprite?.rect).toEqual({ x: 64, y: 0, width: 64, height: 64 });
    expect(sand.sprite?.pivot.y).toBe(0);
    expect(sand.sprite?.pixelsPerUnit).toBe(64);

    expect(palette.get('ice').sprite).toBeNull();
    expect(palette.get('ice').color.a).toBeCloseTo(128 / 255, 3);
    // "props/5" on a 4 x 2 sheet: second row, second column.
    expect(palette.get('rock').sprite?.rect).toEqual({ x: 64, y: 64, width: 64, height: 64 });
    expect(palette.sprite('terrain')?.rect).toEqual({ x: 0, y: 0, width: 128, height: 64 });
    expect(() => palette.get('gras')).toThrow('There is no tile "gras". Did you mean "grass"?');
  });

  test('without textures the tiles are flat colours, which is all a headless test needs', () => {
    const palette = TilePalette.create(PALETTE);
    expect(palette.get('grass').sprite).toBeNull();
    expect(palette.get('grass').data.moveCost).toBe(1);
  });

  test('a palette with mistakes is refused with all of them listed', () => {
    const broken = { tiles: [{ id: 'a' }, { id: 'a' }, { id: 'b', sprite: 'nowhere/x' }] };
    expect(() => TilePalette.create(broken)).toThrow(
      'The tile palette has 2 problems:\n  - Two tiles share the id "a".\n  - Tile "b": sprite "nowhere/x" names the sheet "nowhere", which the palette does not have.',
    );
  });

  test('createTilemaps builds the grid and a painted, drawn layer for each layer of data', () => {
    const palette = TilePalette.create(PALETTE);
    const { grid, tilemaps, layer } = createTilemaps(MAP, palette, { name: 'Board' });

    expect(grid.gameObject.name).toBe('Board');
    expect(grid.cellLayout).toBe(CellLayout.Hexagon);
    expect(grid.cellSwizzle).toBe(CellSwizzle.XZY);
    expect(grid.cellSize.y).toBeCloseTo(1.1547, 4);
    expect(grid.cellGap.x).toBeCloseTo(0.05, 4);
    expect(tilemaps.map((tilemap) => tilemap.name)).toEqual(['Terrain', 'Fog']);

    const terrain = layer('Terrain');
    expect(terrain.getUsedTilesCount()).toBe(5);
    expect(terrain.getTile<Tile<Terrain>>({ x: 0, y: 5 })?.data.climate).toBe('polar');
    expect(terrain.hasTile({ x: -1, y: 5 })).toBe(false);
    expect(terrain.layoutGrid).toBe(grid);

    const fog = layer('Fog');
    expect(fog.getComponent(TilemapRenderer)?.sortingOrder).toBe(2);
    expect(fog.color.a).toBeCloseTo(128 / 255, 3);
    expect(() => layer('Roads')).toThrow('The map has no layer "Roads". Its layers: Terrain, Fog.');

    // Drawn: the cells at x = -1 are in the block left of zero, the rest in the block right of it.
    engine.step();
    expect(terrain.getComponent(TilemapRenderer)?.pcMeshInstances.length).toBe(2);
  });

  test('a map saved from the scene loads back the same', () => {
    const palette = TilePalette.create(PALETTE);
    const first = createTilemaps(MAP, palette);
    first.layer('Terrain').setTile({ x: 6, y: 6 }, palette.get('rock'));
    const saved = tilemapsToData(first.grid);
    expect(checkTilemapData(saved, palette.ids)).toEqual([]);
    // Plain JSON: it survives a trip through a file or the network.
    const second = createTilemaps(JSON.parse(JSON.stringify(saved)) as TilemapData, palette);

    for (const name of ['Terrain', 'Fog']) {
      const a = first.layer(name);
      const b = second.layer(name);
      expect(b.getUsedTilesCount()).toBe(a.getUsedTilesCount());
      for (const cell of a.getUsedCells()) expect(b.getTile(cell)).toBe(a.getTile(cell) as never);
      expect(b.color.equals(a.color)).toBe(true);
      expect(b.getComponent(TilemapRenderer)?.sortingOrder).toBe(
        a.getComponent(TilemapRenderer)?.sortingOrder as number,
      );
    }
    expect(second.grid.getComponentsInChildren(Tilemap).length).toBe(2);
    expect(second.grid.getComponent(Grid)?.cellGap.equals(first.grid.cellGap)).toBe(true);
  });

  test('a map that uses a tile the palette lacks is refused before anything is built', () => {
    const palette = TilePalette.create({ tiles: [{ id: 'grass' }] });
    expect(() => createTilemaps(MAP, palette, { name: 'Board' })).toThrow(
      'The map "Board" has 2 problems:\n  - Layer "Terrain": uses tiles the palette does not define: sand, ice.\n  - Layer "Fog": uses tiles the palette does not define: ice.',
    );
    expect(engine.run(() => Tilemap.name)).toBe('Tilemap');
  });
});
