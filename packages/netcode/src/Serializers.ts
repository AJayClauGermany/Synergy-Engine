import { Color, Quaternion, Vector2, Vector3 } from '@synergy/engine/math';

/**
 * Turns a value into plain JSON data and back. `NetworkVariable` values cross the wire as
 * JSON, so numbers, strings, booleans, arrays and plain objects work as they are. Class
 * instances such as `Vector3` need a serializer, or they would arrive as bare `{x, y, z}`.
 *
 *   readonly target = new NetworkVariable(Vector3.zero, { serializer: Serializers.vector3 });
 */
export interface Serializer<T> {
  write(value: T): unknown;
  read(data: unknown): T;
}

function numbers(data: unknown, length: number): number[] {
  if (!Array.isArray(data) || data.length < length) throw new Error('Malformed network value.');
  return data.map(Number);
}

export const Serializers = {
  vector2: {
    write: (value) => [value.x, value.y],
    read: (data) => {
      const [x = 0, y = 0] = numbers(data, 2);
      return new Vector2(x, y);
    },
  } satisfies Serializer<Vector2>,
  vector3: {
    write: (value) => [value.x, value.y, value.z],
    read: (data) => {
      const [x = 0, y = 0, z = 0] = numbers(data, 3);
      return new Vector3(x, y, z);
    },
  } satisfies Serializer<Vector3>,
  quaternion: {
    write: (value) => [value.x, value.y, value.z, value.w],
    read: (data) => {
      const [x = 0, y = 0, z = 0, w = 1] = numbers(data, 4);
      return new Quaternion(x, y, z, w);
    },
  } satisfies Serializer<Quaternion>,
  color: {
    write: (value) => [value.r, value.g, value.b, value.a],
    read: (data) => {
      const [r = 0, g = 0, b = 0, a = 1] = numbers(data, 4);
      return new Color(r, g, b, a);
    },
  } satisfies Serializer<Color>,
};

/** The serializer used when none is given: the value is already JSON-compatible. */
export const jsonSerializer: Serializer<never> = {
  write: (value) => value,
  read: (data) => data as never,
};
