// The engine's API is in Unity's space (left-handed, +Z forward); PlayCanvas, underneath,
// is right-handed with -Z forward. These tests hold the boundary: what a Unity developer
// writes must look the same here as in Unity, and PlayCanvas must receive the mirror image.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as pc from 'playcanvas';
import {
  BoxCollider,
  CapsuleCollider,
  Engine,
  GameObject,
  Light,
  LightType,
  Mesh,
  MeshFilter,
  MeshRenderer,
  Model,
  Physics,
  PrimitiveType,
  Quaternion,
  SphereCollider,
  Vector2,
  Vector3,
} from '../src';

let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

/** The direction PlayCanvas shines a light, mirrored back into Unity space. */
function shineDirection(light: Light): Vector3 {
  engine.app.fire('prerender');
  const node = light.pcLight.light._node as pc.GraphNode;
  const down = node.getWorldTransform().getY(new pc.Vec3()).mulScalar(-1);
  return new Vector3(down.x, down.y, -down.z).normalized;
}

describe('lights', () => {
  test("shine along transform.forward, as in Unity, whatever PlayCanvas's own convention", () => {
    const sun = new GameObject('Sun').addComponent(Light);
    sun.type = LightType.Directional;
    expect(shineDirection(sun).equals(Vector3.forward, 1e-4)).toBe(true);
    // Unity's default directional light rotation.
    sun.transform.rotation = Quaternion.euler(50, -30, 0);
    expect(shineDirection(sun).equals(sun.transform.forward, 1e-4)).toBe(true);
    expect(sun.transform.forward.y).toBeLessThan(0);
  });

  test('direction aims the light, and a clone keeps shining forward', () => {
    const sun = new GameObject('Sun').addComponent(Light);
    sun.type = LightType.Spot;
    sun.direction = new Vector3(1, -1, 0);
    expect(shineDirection(sun).equals(new Vector3(1, -1, 0).normalized, 1e-4)).toBe(true);
    expect(sun.direction.equals(sun.transform.forward)).toBe(true);
    // Straight down has no forward-based up: still fine.
    sun.direction = Vector3.down;
    expect(shineDirection(sun).equals(Vector3.down, 1e-4)).toBe(true);
    // Unity's default spot cone.
    expect(new GameObject('Spot').addComponent(Light).spotAngle).toBeCloseTo(30);
  });
});

describe('meshes in Unity conventions', () => {
  test('a clockwise triangle with Unity UVs reaches PlayCanvas mirrored, counter-clockwise, v flipped', () => {
    const mesh = new Mesh();
    // Seen from a default camera (at -Z looking along +Z), this is clockwise: a front face in Unity.
    mesh.vertices = [new Vector3(0, 0, 1), new Vector3(0, 1, 1), new Vector3(1, 0, 1)];
    mesh.triangles = [0, 1, 2];
    mesh.uv = [new Vector2(0, 0), new Vector2(0, 1), new Vector2(1, 0)];
    mesh.recalculateNormals();
    const [built] = mesh._resolve(engine);
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];
    built?.getPositions(positions);
    built?.getIndices(indices);
    built?.getUvs(0, uvs);
    built?.getNormals(normals);
    expect(positions).toEqual([0, 0, -1, 0, 1, -1, 1, 0, -1]);
    expect(indices).toEqual([0, 2, 1]);
    expect(uvs).toEqual([0, 1, 0, 0, 1, 1]);
    // The face points back at the camera: -Z in Unity space, +Z in PlayCanvas's.
    expect(normals[2]).toBeCloseTo(1);
  });

  test("a quad's front faces a default camera, as Unity's does", () => {
    const quad = Mesh.primitive(PrimitiveType.Quad);
    expect(quad.normals.every((normal) => normal.equals(Vector3.back))).toBe(true);
    const [a, b, c] = quad.triangles.map((index) => quad.vertices[index] as Vector3);
    // Clockwise seen from the front: in Unity's left-handed world the edges' cross product
    // then points out of the front, toward the camera (-Z), like the normals.
    expect((b as Vector3).sub(a as Vector3).cross((c as Vector3).sub(a as Vector3)).z).toBeLessThan(0);
    // v = 0 at the bottom of the image.
    const bottomLeft = quad.vertices.findIndex((v) => v.x < 0 && v.y < 0);
    expect(quad.uv[bottomLeft]?.equals(new Vector2(0, 0))).toBe(true);
  });

  test('bounds come back in Unity space', () => {
    const cube = GameObject.createPrimitive(PrimitiveType.Cube);
    cube.transform.position = new Vector3(0, 0, 5);
    const bounds = (cube.getComponent(MeshRenderer) as MeshRenderer).bounds;
    engine.step();
    const fresh = (cube.getComponent(MeshRenderer) as MeshRenderer).bounds;
    expect(fresh.center.equals(new Vector3(0, 0, 5), 1e-4)).toBe(true);
    expect(bounds.size.equals(Vector3.one, 1e-4)).toBe(true);
    expect((cube.getComponent(MeshFilter) as MeshFilter).sharedMesh?.bounds.size.equals(Vector3.one, 1e-4)).toBe(true);
  });
});

describe('models', () => {
  test("a glTF model faces the root's forward, where Unity's importers put it", () => {
    // A stand-in for a loaded file: one node holding the content, which faces +Z in glTF's
    // right-handed space. Its nose sits one unit in front of it.
    const content = new pc.Entity('Body');
    const nose = new pc.Entity('Nose');
    nose.setLocalPosition(0, 0, 1);
    content.addChild(nose);
    const container = {
      instantiateRenderEntity: () => {
        const root = new pc.Entity('Root');
        root.addChild(content);
        return root;
      },
    } as unknown as pc.ContainerResource;
    const knight = new Model('Knight', container).instantiate();
    expect(knight.transform.rotation.equals(Quaternion.identity)).toBe(true);
    const noseObject = knight.transform.find('Body/Nose');
    expect(noseObject?.position.equals(Vector3.forward, 1e-4)).toBe(true);
    knight.transform.rotation = Quaternion.euler(0, 90, 0);
    expect(noseObject?.position.equals(Vector3.right, 1e-4)).toBe(true);
  });
});

describe('colliders', () => {
  test("closestPoint follows each shape, so overlapSphere does not count a box's corner region", () => {
    const sphere = GameObject.createPrimitive(PrimitiveType.Sphere);
    const collider = sphere.getComponent(SphereCollider) as SphereCollider;
    expect(collider.closestPoint(new Vector3(3, 0, 0)).equals(new Vector3(0.5, 0, 0), 1e-5)).toBe(true);
    expect(collider.closestPoint(new Vector3(0.1, 0, 0)).equals(new Vector3(0.1, 0, 0))).toBe(true);
    // Near the corner of the sphere's bounding box, but not touching the sphere.
    expect(Physics.overlapSphere(new Vector3(0.6, 0.6, 0.6), 0.2)).toHaveLength(0);
    expect(Physics.overlapSphere(new Vector3(0.6, 0, 0), 0.2)).toHaveLength(1);

    const box = GameObject.createPrimitive(PrimitiveType.Cube);
    box.transform.position = new Vector3(5, 0, 0);
    box.transform.rotation = Quaternion.euler(0, 45, 0);
    const boxCollider = box.getComponent(BoxCollider) as BoxCollider;
    expect(boxCollider.closestPoint(new Vector3(0, 0, 0)).x).toBeCloseTo(5 - Math.SQRT1_2, 4);

    const capsule = GameObject.createPrimitive(PrimitiveType.Capsule);
    capsule.transform.position = new Vector3(-5, 0, 0);
    const capsuleCollider = capsule.getComponent(CapsuleCollider) as CapsuleCollider;
    expect(capsuleCollider.closestPoint(new Vector3(-5, 5, 0)).equals(new Vector3(-5, 1, 0), 1e-5)).toBe(true);
  });

  test("checkSphere skips the Ignore Raycast layer by default, as Unity's does", () => {
    const sphere = GameObject.createPrimitive(PrimitiveType.Sphere);
    sphere.layer = 2;
    expect(Physics.checkSphere(Vector3.zero, 1)).toBe(false);
    expect(Physics.overlapSphere(Vector3.zero, 1)).toHaveLength(1);
  });
});
