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

  test("forward is +Z, as in Unity's left-handed world", () => {
    expect(Vector3.forward.toArray()).toEqual([0, 0, 1]);
    expect(Vector3.back.toArray()).toEqual([0, 0, -1]);
    // Unity: Vector3.Cross(Vector3.right, Vector3.up) == Vector3.forward.
    expect(Vector3.right.cross(Vector3.up).equals(Vector3.forward)).toBe(true);
  });

  test("equality and normalisation use Unity's 1e-5", () => {
    expect(new Vector3(1, 2, 3).equals(new Vector3(1, 2, 3 + 9e-6))).toBe(true);
    // Unity measures the distance, not each axis: 8e-6 on two axes is 1.13e-5 apart.
    expect(new Vector3(0, 0, 0).equals(new Vector3(8e-6, 8e-6, 0))).toBe(false);
    expect(new Vector3(5e-6, 0, 0).normalized).toBe(Vector3.zero);
    expect(new Vector3(2e-5, 0, 0).normalized.equals(Vector3.right)).toBe(true);
  });

  test('helpers', () => {
    close(Vector3.distance(Vector3.zero, new Vector3(3, 4, 0)), 5);
    close(Vector3.angle(Vector3.right, Vector3.up), 90);
    // Unity: SignedAngle(right, up, forward) is 90.
    close(Vector3.signedAngle(Vector3.right, Vector3.up, Vector3.forward), 90);
    // Turning from forward to right about up is a positive (clockwise from above) turn.
    close(Vector3.signedAngle(Vector3.forward, Vector3.right, Vector3.up), 90);
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

describe("Quaternion follows Unity's conventions", () => {
  const samples: [number, number, number][] = [
    [0, 0, 0],
    [30, 0, 0],
    [0, 45, 0],
    [0, 0, 60],
    [10, 20, 30],
    [-75, 130, 15],
    [89, -40, 170],
  ];

  test('euler applies Z, then X, then Y, giving the numbers Unity gives', () => {
    for (const [x, y, z] of samples) {
      const expected = Quaternion.angleAxis(y, Vector3.up)
        .mul(Quaternion.angleAxis(x, Vector3.right))
        .mul(Quaternion.angleAxis(z, Vector3.forward));
      expect(Quaternion.euler(x, y, z).equals(expected)).toBe(true);
    }
    // Unity: Quaternion.Euler(10, 20, 30) is (0.12768, 0.14488, 0.23930, 0.95155).
    const q = Quaternion.euler(10, 20, 30);
    for (const [actual, expected] of [
      [q.x, 0.1276794],
      [q.y, 0.1448781],
      [q.z, 0.2392983],
      [q.w, 0.9515485],
    ] as const) {
      close(actual, expected, 1e-6);
    }
  });

  test('angles turn the way they do in Unity', () => {
    // Positive yaw turns right, positive pitch looks down, positive roll turns right into up.
    expect(Quaternion.euler(0, 90, 0).rotate(Vector3.forward).equals(Vector3.right)).toBe(true);
    expect(Quaternion.euler(90, 0, 0).rotate(Vector3.forward).equals(Vector3.down)).toBe(true);
    expect(Quaternion.euler(0, 0, 90).rotate(Vector3.right).equals(Vector3.up)).toBe(true);
  });

  test('eulerAngles reads back in [0, 360), as Unity does', () => {
    for (const [x, y, z] of samples) {
      const q = Quaternion.euler(x, y, z);
      const angles = q.eulerAngles;
      for (const angle of angles.toArray()) {
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(360);
      }
      expect(Quaternion.angle(Quaternion.euler(angles), q)).toBeLessThan(1e-3);
    }
    expect(Quaternion.euler(-30, 0, 0).eulerAngles.equals(new Vector3(330, 0, 0), 1e-4)).toBe(true);
    expect(Quaternion.euler(0, 270, 0).eulerAngles.equals(new Vector3(0, 270, 0), 1e-4)).toBe(true);
    // Three quarter turns: no -360 or 360 creeping in.
    const quarter = Quaternion.angleAxis(90, Vector3.up);
    expect(
      quarter
        .mul(quarter)
        .mul(quarter)
        .eulerAngles.equals(new Vector3(0, 270, 0), 1e-4),
    ).toBe(true);
    // Straight down (pitch 90) with a yaw.
    expect(Quaternion.euler(90, 45, 0).eulerAngles.equals(new Vector3(90, 45, 0), 1e-3)).toBe(true);
  });

  test('a rotation crosses into PlayCanvas as the mirror image, so it renders the same', () => {
    // Unity space mirrored in Z is PlayCanvas space. Rotating a mirrored vector with the
    // converted rotation must give the mirror of the Unity result.
    const mirror = (v: { x: number; y: number; z: number }) => new pc.Vec3(v.x, v.y, -v.z);
    for (const [x, y, z] of samples) {
      const q = Quaternion.euler(x, y, z);
      const converted = new pc.Quat(-q.x, -q.y, q.z, q.w);
      const v = new Vector3(1, -2, 3);
      const viaPlayCanvas = converted.transformVector(mirror(v), new pc.Vec3());
      expect(Vector3.from(viaPlayCanvas).equals(Vector3.from(mirror(q.rotate(v))), 1e-5)).toBe(true);
    }
  });

  test('multiply and rotate', () => {
    for (const [x, y, z] of samples) {
      const a = Quaternion.euler(x, y, z);
      const b = Quaternion.euler(z, x, y);
      const v = new Vector3(1, -2, 3);
      // a * b applies b first, then a.
      expect(
        a
          .mul(b)
          .rotate(v)
          .equals(a.rotate(b.rotate(v)), 1e-5),
      ).toBe(true);
      expect(a.mul(a.inverse()).equals(Quaternion.identity)).toBe(true);
    }
  });

  test("equals is Unity's ==: within about 0.16 degrees, and q is not -q", () => {
    const q = Quaternion.euler(10, 20, 30);
    expect(q.equals(Quaternion.euler(10, 20, 30.1))).toBe(true);
    expect(q.equals(Quaternion.euler(10, 20, 30.4))).toBe(false);
    expect(q.equals(new Quaternion(-q.x, -q.y, -q.z, -q.w))).toBe(false);
    expect(Quaternion.angleAxis(45, Vector3.zero)).toBe(Quaternion.identity);
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

  test('lookRotation points forward (+Z) at the target and keeps up up', () => {
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
    // Unity: LookRotation(right) is a yaw of 90; up stays up.
    const right = Quaternion.lookRotation(Vector3.right);
    expect(right.equals(Quaternion.euler(0, 90, 0))).toBe(true);
    expect(right.rotate(Vector3.up).equals(Vector3.up)).toBe(true);
    expect(Quaternion.lookRotation(Vector3.zero)).toBe(Quaternion.identity);
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
