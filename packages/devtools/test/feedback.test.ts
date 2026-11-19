import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BoxCollider,
  Camera,
  CellSwizzle,
  Color,
  Engine,
  GameObject,
  Grid,
  MonoBehaviour,
  Tile,
  Tilemap,
  Vector3,
} from '@synergy/engine';
import { describeWorld } from '../src/feedback/describe';
import { type FeedbackContext, type FeedbackNote, formatFeedback } from '../src/feedback/format';
import { pickWorld, viewRectOf } from '../src/feedback/pick';
import { LogCapture } from '../src/logs';
import { buildReport } from '../src/report';

/** The feedback tool's parts that need no page: picking in the world, describing it, and the prompt. */
let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

class Scout extends MonoBehaviour {
  moveRange = 3;
}

/** A camera looking straight down at the origin from 10 up, and the middle of its view. */
function lookDown(): { x: number; y: number } {
  const camera = new GameObject('Main Camera');
  camera.tag = 'MainCamera';
  camera.addComponent(Camera);
  camera.transform.position = new Vector3(0, 10, 0);
  camera.transform.eulerAngles = new Vector3(90, 0, 0);
  const { width, height } = engine.canvasSize;
  return { x: width / 2, y: height / 2 };
}

function board(): Grid {
  const grid = new GameObject('Board').addComponent(Grid);
  grid.cellSwizzle = CellSwizzle.XZY;
  const terrain = new GameObject('Terrain');
  terrain.transform.parent = grid.transform;
  terrain
    .addComponent(Tilemap)
    .setTile({ x: 0, y: 0 }, new Tile({ name: 'Grass', color: Color.green, data: { cost: 1 } }));
  return grid;
}

describe('picking what the engine drew', () => {
  test('a GameObject under the point is picked by its collider, with the map cell it stands on', () => {
    const centre = lookDown();
    board();
    const unit = new GameObject('Scout');
    unit.addComponent(BoxCollider);
    unit.transform.position = new Vector3(0.5, 0.5, 0.5);
    const pick = pickWorld(engine, { x: centre.x + 20, y: centre.y - 20 });
    expect(pick.kind).toBe('gameObject');
    if (pick.kind !== 'gameObject') return;
    expect(pick.gameObject).toBe(unit);
    expect(pick.cell?.cell).toEqual({ x: 0, y: 0 });
    // It shows where the camera puts it: right of and above the middle (view y runs down).
    const rect = viewRectOf(engine, unit);
    expect(rect && rect.x + rect.width / 2).toBeGreaterThan(centre.x);
    expect(rect && rect.y + rect.height / 2).toBeLessThan(centre.y);
  });

  test('with nothing standing there the map cell is picked; off the map, nothing', () => {
    const centre = lookDown();
    board();
    const onMap = pickWorld(engine, { x: centre.x + 20, y: centre.y - 20 });
    expect(onMap.kind === 'tile' && onMap.cell.cell).toEqual({ x: 0, y: 0 });
    expect(pickWorld(engine, { x: 1, y: 1 }).kind).toBe('empty');
  });

  test('a scene without a camera has nothing to pick, and says so without throwing', () => {
    new GameObject('Lonely').addComponent(BoxCollider);
    expect(pickWorld(engine, { x: 10, y: 10 })).toEqual({ kind: 'empty' });
  });
});

describe('describing what was picked', () => {
  test('a GameObject: where it is in the scene, its scripts, its cell, and its fields at standard detail', () => {
    const centre = lookDown();
    board();
    const squad = new GameObject('Squad');
    const unit = new GameObject('Scout');
    unit.transform.parent = squad.transform;
    unit.addComponent(BoxCollider);
    unit.addComponent(Scout);
    unit.transform.position = new Vector3(0.5, 0.5, 0.5);
    const described = describeWorld(engine, pickWorld(engine, { x: centre.x + 20, y: centre.y - 20 }));
    expect(described.kind).toBe('GameObject');
    expect(described.label).toBe('"Scout"');
    const fact = (label: string) => described.facts.find((entry) => entry.label === label)?.value;
    expect(fact('GameObject')).toContain('Squad / Scout');
    expect(fact('Scripts')).toContain('class Scout');
    expect(fact('Tiles on that cell')).toBe('Terrain: Grass {"cost":1}');
    const inspector = described.blocks.find((block) => block.level === 'standard');
    expect(inspector?.text).toContain('moveRange=3');
  });

  test('a map cell and empty space', () => {
    const centre = lookDown();
    board();
    const cell = describeWorld(engine, pickWorld(engine, { x: centre.x + 20, y: centre.y - 20 }));
    expect([cell.kind, cell.label]).toEqual(['Map cell', '(0, 0)']);
    expect(describeWorld(engine, { kind: 'empty' }).kind).toBe('Empty space');
  });
});

const context: FeedbackContext = {
  page: 'http://localhost:3000/?scene=Menu',
  scenes: ['Menu'],
  activeScene: 'Menu',
  frame: 12,
  time: 1.5,
  paused: true,
  view: { width: 1280, height: 720 },
  extra: { Screen: 'Menu' },
};

const title: FeedbackNote = {
  id: 1,
  comment: 'Make the title gold\nand a little lower',
  at: { x: 470, y: 230 },
  expected: { x: 640, y: 300 },
  target: {
    kind: 'HUD element',
    label: '<h1> "Synergy"',
    rect: { x: 440, y: 220, width: 400, height: 40 },
    facts: [
      { label: 'Source', value: '`game/src/ui/App.tsx:44:7`', level: 'brief' },
      { label: 'Looks', value: 'color: rgb(233, 238, 244)', level: 'standard' },
    ],
    blocks: [{ title: 'Its HTML', text: '<h1>Synergy ```</h1>', lang: 'html', level: 'full' }],
  },
};

describe('the prompt', () => {
  test('says where the game was, what was clicked, where its code is, and what the person said', () => {
    const prompt = formatFeedback([title], context, { detail: 'brief' });
    expect(prompt).toContain('# Feedback on the running game (1 note)');
    expect(prompt).toContain('- Screen: Menu');
    expect(prompt).toContain('(paused)');
    expect(prompt).toContain('## Note 1: HUD element <h1> "Synergy"');
    expect(prompt).toContain('> Make the title gold\n> and a little lower');
    expect(prompt).toContain('- Source: `game/src/ui/App.tsx:44:7`');
    expect(prompt).toContain('- On screen: left 440, top 220, 400×40');
  });

  test('the expected spot is given as a distance from where the thing is now', () => {
    const prompt = formatFeedback([title], context, { detail: 'brief' });
    // Its centre is (640, 240): the spot is straight below it.
    expect(prompt).toContain('**Expected at: (640, 300)**, 60 px down of its centre now');
  });

  test('the detail level decides what is included; a block cannot be closed by its own text', () => {
    const brief = formatFeedback([title], context, { detail: 'brief' });
    expect(brief).not.toContain('Looks');
    expect(brief).not.toContain('Its HTML');
    const standard = formatFeedback([title], context, { detail: 'standard' });
    expect(standard).toContain('- Looks: color: rgb(233, 238, 244)');
    expect(standard).not.toContain('Its HTML');
    const full = formatFeedback([title], context, { detail: 'full' });
    expect(full).toContain('````html\n<h1>Synergy ```</h1>\n````');
  });

  test('names the pictures when there is a report folder, and only then', () => {
    const saved = formatFeedback([title], context, { detail: 'brief', folder: '.reports/now', images: true });
    expect(saved).toContain('`.reports/now/feedback.png`');
    expect(saved).toContain('- Close-up: `.reports/now/note-1.png`');
    expect(formatFeedback([title], context, { detail: 'brief' })).not.toContain('note-1.png');
  });
});

describe('a report with feedback', () => {
  test('carries the feedback files and points at them first', async () => {
    const report = await buildReport(engine, new LogCapture(), 'note', {
      files: { 'feedback.md': '# notes' },
      images: { 'feedback.png': 'data:image/png;base64,AA==' },
    });
    expect(report.files['feedback.md']).toBe('# notes');
    expect(report.images).toEqual({ 'feedback.png': 'data:image/png;base64,AA==' });
    expect(report.files['summary.md']).toContain('`feedback.md`: read this first');
    const plain = await buildReport(engine, new LogCapture(), 'note');
    expect(plain.files['summary.md']).not.toContain('feedback.md');
  });
});
