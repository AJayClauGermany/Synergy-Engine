import { nameType, Quaternion, Vector3 } from '@synergy/engine';
import { NetworkBehaviour } from './NetworkBehaviour';
import { NetworkVariable, NetworkVariableWritePermission } from './NetworkVariable';
import type { Quat, Vec3 } from './protocol';

/** What travels: only the parts that are synchronized. `tp` marks a teleport. */
interface TransformState {
  p?: Vec3;
  r?: Quat;
  s?: Vec3;
  tp?: 1;
}

interface Sample {
  time: number;
  applied?: true;
  p?: Vector3;
  r?: Quaternion;
  s?: Vector3;
}

/**
 * Keeps an object's position, rotation and scale in step. Unity: `NetworkTransform`
 * (set `authority` to `'owner'` for `ClientNetworkTransform`).
 *
 *   go.addComponent(NetworkTransform);                       // the server moves it, everyone follows
 *   go.addComponent(NetworkTransform).authority = 'owner';   // the owning player moves it
 *
 * The side with authority moves the object however it likes; once per tick, if it moved
 * more than the thresholds, the new transform is sent. Everyone else shows it a little
 * in the past (`interpolationTicks`) and blends between updates, so motion looks smooth
 * at 30 updates a second. Set values like these on the prefab, so every machine agrees.
 */
export class NetworkTransform extends NetworkBehaviour {
  /** Who moves the object: the server, or its owner. */
  authority: 'server' | 'owner' = 'server';
  syncPosition = true;
  syncRotation = true;
  syncScale = false;
  /** World units a position must change by before it is sent. */
  positionThreshold = 0.001;
  /** Degrees a rotation must change by before it is sent. */
  rotationThreshold = 0.01;
  /** How much a scale must change by before it is sent. */
  scaleThreshold = 0.01;
  /** Blend between updates instead of jumping. */
  interpolate = true;
  /** How many ticks behind the newest update copies are shown. Bigger is smoother and later. */
  interpolationTicks = 2;

  private readonly state = new NetworkVariable<TransformState | null>(null);
  private samples: Sample[] = [];
  private lastPosition = Vector3.zero;
  private lastRotation = Quaternion.identity;
  private lastScale = Vector3.one;
  private subscriptions: (() => void)[] = [];

  /** This machine moves the object (and sends the result). */
  get hasAuthority(): boolean {
    return this.authority === 'owner' ? this.isOwner : this.isServer;
  }

  onNetworkSpawn(): void {
    this.state.writePermission =
      this.authority === 'owner' ? NetworkVariableWritePermission.Owner : NetworkVariableWritePermission.Server;
    this.remember();
    this.subscriptions = [
      this.networkManager.onTick.add(() => this.sample()),
      this.state.onValueChanged.add((_previous, current) => this.receive(current)),
    ];
    // A late joiner's snapshot already placed the object; later updates blend from there.
  }

  onNetworkDespawn(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.samples = [];
  }

  /**
   * Moves the object at once on every machine, with no blending. Only the machine with
   * authority can do this.
   */
  teleport(position: Vector3, rotation?: Quaternion): void {
    if (!this.hasAuthority) throw new Error(`Only the machine with authority can teleport "${this.name}".`);
    this.transform.position = position;
    if (rotation) this.transform.rotation = rotation;
    this.remember();
    this.state.value = { ...this.capture(), tp: 1 };
  }

  private remember(): void {
    this.lastPosition = this.transform.position;
    this.lastRotation = this.transform.rotation;
    this.lastScale = this.transform.localScale;
  }

  private capture(): TransformState {
    const state: TransformState = {};
    if (this.syncPosition) state.p = this.transform.position.toArray();
    if (this.syncRotation) state.r = this.transform.rotation.toArray();
    if (this.syncScale) state.s = this.transform.localScale.toArray();
    return state;
  }

  /** Once per tick, on the machine with authority: send the transform if it moved enough. */
  private sample(): void {
    if (!this.hasAuthority) return;
    const { transform } = this;
    const moved =
      (this.syncPosition && Vector3.distance(transform.position, this.lastPosition) > this.positionThreshold) ||
      (this.syncRotation && Quaternion.angle(transform.rotation, this.lastRotation) > this.rotationThreshold) ||
      (this.syncScale && Vector3.distance(transform.localScale, this.lastScale) > this.scaleThreshold);
    if (!moved) return;
    this.remember();
    this.state.value = this.capture();
  }

  /** A new transform arrived from the machine with authority. */
  private receive(state: TransformState | null): void {
    if (!state || this.hasAuthority) return;
    const manager = this.networkManager;
    const now = manager.networkClock;
    const sample: Sample = {
      time: now,
      p: state.p && new Vector3(...state.p),
      r: state.r && new Quaternion(...state.r),
      s: state.s && new Vector3(...state.s),
    };
    if (state.tp || !this.interpolate) {
      this.samples = [];
      this.apply(sample);
      return;
    }
    // Start the blend from where the object is now, one tick before this update arrived.
    const start = now - 1 / manager.networkConfig.tickRate;
    const last = this.samples[this.samples.length - 1];
    if (!last || last.time < start - 1e-6) {
      const { transform } = this;
      this.samples.push({ time: start, p: transform.position, r: transform.rotation, s: transform.localScale });
    }
    this.samples.push(sample);
  }

  update(): void {
    if (!this.isSpawned) return;
    if (this.hasAuthority) {
      this.samples = []; // authority may have just moved here (ownership change): old updates are stale
      return;
    }
    if (this.samples.length === 0) return;
    const manager = this.networkManager;
    const renderTime = manager.networkClock - this.interpolationTicks / manager.networkConfig.tickRate;
    // Drop samples we have fully passed, keeping the last one before renderTime.
    while (this.samples.length >= 2 && (this.samples[1] as Sample).time <= renderTime) this.samples.shift();
    const from = this.samples[0] as Sample;
    const to = this.samples[1];
    if (!to || renderTime <= from.time) {
      // Only one sample, or none old enough yet: hold the closest we have.
      if (!to && !from.applied) {
        from.applied = true; // once: afterwards the object is free to be moved locally
        this.apply(from);
      }
      return;
    }
    const t = Math.min(1, (renderTime - from.time) / (to.time - from.time));
    this.apply({
      time: renderTime,
      p: from.p && to.p ? Vector3.lerp(from.p, to.p, t) : to.p,
      r: from.r && to.r ? Quaternion.slerp(from.r, to.r, t) : to.r,
      s: from.s && to.s ? Vector3.lerp(from.s, to.s, t) : to.s,
    });
  }

  private apply(sample: Sample): void {
    if (this.syncPosition && sample.p) this.transform.position = sample.p;
    if (this.syncRotation && sample.r) this.transform.rotation = sample.r;
    if (this.syncScale && sample.s) this.transform.localScale = sample.s;
  }
}

// The names to print, whatever a bundler renames these classes to (see nameType).
nameType(NetworkTransform, 'NetworkTransform');
