import { describe, expect, test } from 'bun:test';
import * as pc from 'playcanvas';
import { Bounds, Color, Mathf, Plane, Quaternion, Ray, Vector2, Vector3, Vector3Int } from '../src/math';

const close = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('Vector3', () => {
  test('is immutable and uses value-style operations', () => {
    const a = new Vector3(1, 2, 3);
    const b = a.add(new Vector3(1, 1, 1));
    expect(a.toArray()).toEqual([1, 2, 3]);
    expect(b.toArray()).toEqual([2, 3, 4]);
    expect(a.mul(2).toArray()).toEqual([2, 4, 6]);
    expect(a.neg().toArray()).toEqual([-1, -2, -3]);
  });

  test('forward is -Z (right-handed world)', () => {
    expect(Vector3.forward.toArray()).toEqual([0, 0, -1]);
    expect(Vector3.right.cross(Vector3.up).equals(Vector3.back)).toBe(true);
  });

  test('helpers', () => {
    close(Vector3.distance(Vector3.zero, new Vector3(3, 4, 0)), 5);
    close(Vector3.angle(Vector3.right, Vector3.up), 90);
    close(Vector3.signedAngle(Vector3.right, Vector3.up, Vector3.back), 90);
    expect(Vector3.moveTowards(Vector3.zero, new Vector3(10, 0, 0), 4).equals(new Vector3(4, 0, 0))).toBe(true);
    expect(Vector3.moveTowards(Vector3.zero, Vector3.one, 100)).toBe(Vector3.one);
    expect(Vector3.projectOnPlane(new Vector3(1, 5, 2), Vector3.up).equals(new Vector3(1, 0, 2))).toBe(true);
    close(new Vector3(0, 3, 4).normalized.magnitude, 1);
    expect(Vector3.zero.normalized).toBe(Vector3.zero);
  });
});

describe('Vector2', () => {
  test('basics', () => {
    close(new Vector2(3, 4).magnitude, 5);
    expect(Vector2.lerp(Vector2.zero, new Vector2(2, 4), 0.5).equals(new Vector2(1, 2))).toBe(true);
  });
});

describe('Quaternion matches PlayCanvas conventions', () => {
  const samples: [number, number, number][] = [
    [0, 0, 0],
    [30, 0, 0],
    [0, 45, 0],
    [0, 0, 60],
    [10, 20, 30],
    [-75, 130, 15],
    [89, -40, 170],
  ];

  test('euler -> quaternion -> euler', () => {
    for (const [x, y, z] of samples) {
      const expected = new pc.Quat().setFromEulerAngles(x, y, z);
      const actual = Quaternion.euler(x, y, z);
      expect(actual.equals(expected)).toBe(true);
      const expectedAngles = expected.getEulerAngles();
      expect(actual.eulerAngles.equals(expectedAngles, 1e-3)).toBe(true);
    }
  });

  test('multiply and rotate', () => {
    for (const [x, y, z] of samples) {
      const a = Quaternion.euler(x, y, z);
      const b = Quaternion.euler(z, x, y);
      const pa = new pc.Quat().setFromEulerAngles(x, y, z);
      const pb = new pc.Quat().setFromEulerAngles(z, x, y);
      expect(a.mul(b).equals(new pc.Quat().mul2(pa, pb))).toBe(true);
      const v = new pc.Vec3(1, -2, 3);
      expect(a.rotate(v).equals(pa.transformVector(v, new pc.Vec3()))).toBe(true);
      expect(a.mul(a.inverse()).equals(Quaternion.identity)).toBe(true);
    }
  });

  test('angleAxis and slerp', () => {
    const expected = new pc.Quat().setFromAxisAngle(pc.Vec3.UP, 70);
    expect(Quaternion.angleAxis(70, Vector3.up).equals(expected)).toBe(true);
    const a = Quaternion.euler(0, 0, 0);
    const b = Quaternion.euler(0, 90, 0);
    expect(Quaternion.slerp(a, b, 0.5).equals(Quaternion.euler(0, 45, 0))).toBe(true);
    close(Quaternion.angle(a, b), 90, 1e-3);
    expect(Quaternion.rotateTowards(a, b, 30).equals(Quaternion.euler(0, 30, 0))).toBe(true);
    expect(Quaternion.rotateTowards(a, b, 500).equals(b)).toBe(true);
  });

  test('lookRotation points -Z at the target, like Entity.lookAt', () => {
    const directions = [
      new Vector3(1, 0, 0),
      new Vector3(0, 0, 1),
      new Vector3(1, -1, 1),
      new Vector3(-3, 2, -0.5),
      Vector3.up,
      Vector3.down,
    ];
    for (const direction of directions) {
      const rotation = Quaternion.lookRotation(direction);
      expect(rotation.rotate(Vector3.forward).equals(direction.normalized, 1e-4)).toBe(true);
    }
    const node = new pc.GraphNode();
    node.lookAt(new pc.Vec3(1, -1, 1));
    expect(Quaternion.lookRotation(new Vector3(1, -1, 1)).equals(node.getRotation())).toBe(true);
  });

  test('fromToRotation', () => {
    const q = Quaternion.fromToRotation(Vector3.right, Vector3.up);
    expect(q.rotate(Vector3.right).equals(Vector3.up)).toBe(true);
    const flip = Quaternion.fromToRotation(Vector3.right, Vector3.left);
    expect(flip.rotate(Vector3.right).equals(Vector3.left)).toBe(true);
  });
});

describe('Mathf', () => {
  test("rounding sends halfway values to the even number, as Unity's Mathf.Round does", () => {
    const halves = [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5];
    expect(halves.map(Mathf.roundToInt)).toEqual([0, 2, 2, 4, 0, -2, -2]);
    expect(halves.map(Mathf.round)).toEqual([0, 2, 2, 4, 0, -2, -2]);
    expect([2.4, 2.6, -2.4, -2.6, 7].map(Mathf.roundToInt)).toEqual([2, 3, -2, -3, 7]);
    expect(Vector3Int.roundToInt(new Vector3(0.5, 1.5, -2.5)).equals(new Vector3Int(0, 2, -2))).toBe(true);
  });

  test('helpers', () => {
    expect(Mathf.clamp(5, 0, 3)).toBe(3);
    expect(Mathf.lerp(0, 10, 2)).toBe(10);
    expect(Mathf.lerpUnclamped(0, 10, 2)).toBe(20);
    expect(Mathf.inverseLerp(10, 20, 15)).toBe(0.5);
    expect(Mathf.moveTowards(0, 10, 3)).toBe(3);
    expect(Mathf.moveTowards(9, 10, 3)).toBe(10);
    expect(Mathf.repeat(-1, 5)).toBe(4);
    expect(Mathf.pingPong(7, 5)).toBe(3);
    expect(Mathf.deltaAngle(350, 10)).toBe(20);
    expect(Mathf.deltaAngle(10, 350)).toBe(-20);
    expect(Mathf.approximately(0.1 + 0.2, 0.3)).toBe(true);
  });

  test('smoothDamp converges without overshooting', () => {
    let value = 0;
    let velocity = 0;
    for (let i = 0; i < 300; i++) {
      [value, velocity] = Mathf.smoothDamp(value, 10, velocity, 0.3, Infinity, 1 / 60);
      expect(value).toBeLessThanOrEqual(10);
    }
    close(value, 10, 1e-2);
  });
});

describe('Color', () => {
  test('hex round trip', () => {
    expect(Color.fromHex('#ff8000').equals(new Color(1, 128 / 255, 0))).toBe(true);
    expect(Color.fromHex('f80').toHex()).toBe('#ff8800');
    expect(new Color(1, 0, 0, 0.5).toHex()).toBe('#ff000080');
    expect(() => Color.fromHex('nope')).toThrow();
  });

  test('hsv', () => {
    expect(Color.hsvToRgb(0, 1, 1).equals(Color.red)).toBe(true);
    expect(Color.hsvToRgb(1 / 3, 1, 1).equals(Color.green)).toBe(true);
  });
});

describe('Ray, Plane, Bounds', () => {
  test('plane raycast finds the ground point', () => {
    const ground = new Plane(Vector3.up, Vector3.zero);
    const ray = new Ray(new Vector3(0, 10, 0), new Vector3(1, -1, 0));
    const distance = ground.raycast(ray);
    expect(distance).not.toBeNull();
    expect(ray.getPoint(distance as number).equals(new Vector3(10, 0, 0), 1e-4)).toBe(true);
    expect(ground.raycast(new Ray(new Vector3(0, 10, 0), Vector3.up))).toBeNull();
    expect(ground.raycast(new Ray(new Vector3(0, 10, 0), Vector3.right))).toBeNull();
  });

  test('bounds', () => {
    const bounds = new Bounds(Vector3.zero, new Vector3(2, 2, 2));
    expect(bounds.contains(new Vector3(0.5, -1, 1))).toBe(true);
    expect(bounds.contains(new Vector3(0.5, -1.1, 1))).toBe(false);
    close(bounds.intersectRay(new Ray(new Vector3(-5, 0, 0), Vector3.right)) as number, 4);
    expect(bounds.intersectRay(new Ray(new Vector3(-5, 3, 0), Vector3.right))).toBeNull();
    expect(bounds.intersectRay(new Ray(new Vector3(-5, 0, 0), Vector3.left))).toBeNull();
    expect(bounds.encapsulate(new Vector3(3, 0, 0)).max.x).toBe(3);
    expect(bounds.intersects(new Bounds(new Vector3(1.5, 0, 0), Vector3.one))).toBe(true);
    expect(bounds.intersects(new Bounds(new Vector3(2.5, 0, 0), Vector3.one))).toBe(false);
  });
});
