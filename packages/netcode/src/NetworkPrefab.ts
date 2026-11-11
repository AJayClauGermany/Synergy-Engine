import { type GameObject, Prefab } from '@synergy/engine';
import { NetworkObject } from './NetworkObject';

/**
 * A `Prefab` that can be spawned over the network. Unity: a prefab with a `NetworkObject`
 * on its root, listed in the `NetworkManager`'s prefab list.
 *
 *   export const UnitPrefab = new NetworkPrefab('Unit', (go) => {
 *     go.addComponent(MeshFilter).mesh = Mesh.primitive(PrimitiveType.Capsule);
 *     go.addComponent(MeshRenderer);
 *     go.addComponent(Unit);
 *   });
 *
 *   manager.networkPrefabs.add(UnitPrefab);                          // on every machine
 *   instantiate(UnitPrefab, position).getComponent(NetworkObject)?.spawn();   // on the server
 *
 * The `NetworkObject` is added first, before your build function runs. The name identifies
 * the prefab on the wire, so it must be unique and the same on every machine.
 */
export class NetworkPrefab extends Prefab {
  constructor(name: string, build: (gameObject: GameObject) => void = () => {}) {
    super(name, (gameObject) => {
      gameObject.addComponent(NetworkObject)._prefabName = name;
      build(gameObject);
    });
  }
}

/** The prefabs that can be spawned. Unity: `NetworkPrefabsList`. Server and clients must register the same ones. */
export class NetworkPrefabs {
  private readonly byName = new Map<string, NetworkPrefab>();

  add(prefab: NetworkPrefab): this {
    const existing = this.byName.get(prefab.name);
    if (existing && existing !== prefab) {
      throw new Error(`Two different NetworkPrefabs are named "${prefab.name}". Names must be unique.`);
    }
    this.byName.set(prefab.name, prefab);
    return this;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): NetworkPrefab | undefined {
    return this.byName.get(name);
  }

  get list(): readonly NetworkPrefab[] {
    return [...this.byName.values()];
  }

  /** A fingerprint of the registered names, compared when a client connects. */
  get hash(): string {
    let hash = 0x811c9dc5;
    for (const char of [...this.byName.keys()].sort().join('|')) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }
    return hash.toString(16);
  }
}
