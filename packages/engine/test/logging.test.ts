import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  Application,
  Color,
  Debug,
  Engine,
  GameObject,
  Gizmos,
  LogType,
  MonoBehaviour,
  ScreenCapture,
  Vector3,
} from '../src';

/** Unity's logging and editor-facing APIs: what reaches `Application.logMessageReceived`, gizmos, captures. */
let engine: Engine;
let received: [string, string, LogType][];
let stopListening: () => void;

beforeEach(() => {
  engine = Engine.createHeadless();
  received = [];
  stopListening = Application.logMessageReceived.addListener((condition, stackTrace, type) => {
    received.push([condition, stackTrace, type]);
  });
});

afterEach(() => {
  stopListening();
  engine.dispose();
});

/** Runs `action` with the console quiet, so a test's own logging does not fill the output. */
function quietly(action: () => void): void {
  const spies = (['log', 'warn', 'error'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  try {
    action();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('Application.logMessageReceived', () => {
  test('hears every Debug log call with its LogType, and a stack for the serious ones', () => {
    quietly(() => {
      Debug.log('moved to', new Vector3(1, 2, 3));
      Debug.logWarning('low ammo');
      Debug.logError('no path');
      Debug.assert(1 + 1 === 3, 'arithmetic');
      Debug.assert(true, 'never logged');
      Debug.logException(new RangeError('out of range'));
    });
    expect(received.map(([condition, , type]) => [condition, type])).toEqual([
      [`moved to ${new Vector3(1, 2, 3).toString()}`, LogType.Log],
      ['low ammo', LogType.Warning],
      ['no path', LogType.Error],
      ['Assertion failed: arithmetic', LogType.Assert],
      ['RangeError: out of range', LogType.Exception],
    ]);
    expect(received[0]?.[1]).toBe('');
    expect(received[2]?.[1]).toContain('logging.test.ts');
    expect(received[4]?.[1]).toContain('logging.test.ts');
  });

  test("Unity's context argument names the object in the message", () => {
    const board = new GameObject('Board');
    quietly(() => Debug.log('selected', board));
    expect(received[0]?.[0]).toBe('selected Board (GameObject)');
  });

  test('an exception a script throws arrives as LogType.Exception', () => {
    engine.dispose();
    engine = Engine.createHeadless({ throwOnError: false });
    class Broken extends MonoBehaviour {
      update() {
        throw new Error('broken on purpose');
      }
    }
    new GameObject('B').addComponent(Broken);
    quietly(() => engine.step());
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]).toBe('Exception in Broken.update on "B": Error: broken on purpose');
    expect(received[0]?.[2]).toBe(LogType.Exception);
  });

  test('a listener that throws does not break the code that logged', () => {
    const off = Application.logMessageReceived.addListener(() => {
      throw new Error('bad listener');
    });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      quietly(() => Debug.log('still fine'));
      expect(received[0]?.[0]).toBe('still fine');
    } finally {
      off();
      errors.mockRestore();
    }
  });
});

describe('the editor hooks', () => {
  test('with no editor attached, Debug.break() does nothing and Application.isEditor is false', () => {
    expect(Application.isEditor).toBe(false);
    expect(() => Debug.break()).not.toThrow();
  });

  test('with an editor attached, Debug.break() asks it to pause', () => {
    let paused = 0;
    engine.editor = { pause: () => paused++, saveScreenshot: () => Promise.resolve(null) };
    expect(Application.isEditor).toBe(true);
    Debug.break();
    expect(paused).toBe(1);
  });

  test('isDebugBuild is true outside a release build', () => {
    expect(Debug.isDebugBuild).toBe(true);
  });

  test('a headless engine draws nothing, so a capture resolves to null', async () => {
    expect(await ScreenCapture.captureScreenshotAsDataUrl()).toBeNull();
    expect(await ScreenCapture.captureScreenshot('x.png')).toBeNull();
  });
});

describe('gizmos', () => {
  test('onDrawGizmos reaches every active, enabled script; onDrawGizmosSelected only the selection and below', () => {
    const calls: string[] = [];
    class Range extends MonoBehaviour {
      radius = 2;
      protected onDrawGizmos() {
        calls.push(`all:${this.name}`);
        Gizmos.drawLine(Vector3.zero, Vector3.up);
      }
      protected onDrawGizmosSelected() {
        calls.push(`selected:${this.name}`);
        Gizmos.color = Color.yellow;
        Gizmos.drawWireSphere(this.transform.position, this.radius);
      }
    }
    const parent = new GameObject('Parent');
    parent.addComponent(Range);
    const child = new GameObject('Child');
    child.transform.parent = parent.transform;
    child.addComponent(Range);
    new GameObject('Other').addComponent(Range);
    const hidden = new GameObject('Hidden');
    hidden.addComponent(Range);
    hidden.setActive(false);
    new GameObject('Off').addComponent(Range).enabled = false;

    const lines = Gizmos._drawAll(parent);
    expect(calls.toSorted()).toEqual(
      ['all:Parent', 'selected:Parent', 'all:Child', 'selected:Child', 'all:Other'].toSorted(),
    );
    // Three lines from onDrawGizmos, and two spheres of three 24-segment circles.
    expect(lines).toBe(3 + 2 * 3 * 24);
    expect(Gizmos.color).toEqual(Color.white);
  });

  test('drawWireCube draws the twelve edges of the box', () => {
    class Box extends MonoBehaviour {
      protected onDrawGizmos() {
        Gizmos.drawWireCube(Vector3.zero, Vector3.one);
      }
    }
    new GameObject('Box').addComponent(Box);
    expect(Gizmos._drawAll(null)).toBe(12);
  });

  test('an exception in onDrawGizmos is reported like any other message', () => {
    class Bad extends MonoBehaviour {
      protected onDrawGizmos() {
        throw new Error('bad gizmo');
      }
    }
    new GameObject('Bad').addComponent(Bad);
    expect(() => Gizmos._drawAll(null)).toThrow('bad gizmo [in Bad.onDrawGizmos on "Bad"]');
  });

  test("Unity's spelling of the gizmo messages is an error, as for the others", () => {
    class Old extends MonoBehaviour {
      // @ts-expect-error Unity's spelling.
      OnDrawGizmos() {}
    }
    expect(() => new GameObject('O').addComponent(Old)).toThrow('Rename it to onDrawGizmos()');
  });
});
