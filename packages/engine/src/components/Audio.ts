import * as pc from 'playcanvas';
import { Behaviour } from '../core/Component';
import { GameObject } from '../core/GameObject';
import { destroy, findAnyObjectByType } from '../core/Object';
import { currentEngine } from '../core/runtime';
import { nameType } from '../core/typeNames';
import type { Vector3 } from '../math/Vector3';

/**
 * A loaded sound. Unity: `AudioClip`. Get one with `await Assets.loadAudioClip(url)`.
 */
export class AudioClip {
  /** @internal */
  constructor(
    readonly name: string,
    /** The PlayCanvas asset behind the clip. An escape hatch. */
    readonly pcAsset: pc.Asset,
  ) {}

  /** Length in seconds. Same as Unity. */
  get length(): number {
    return (this.pcAsset.resource as pc.Sound | null)?.duration ?? 0;
  }
}

/**
 * Hears the scene's sounds: 3D sounds are louder near it and pan by where they are
 * relative to it. Unity: `AudioListener`. As in Unity, put exactly one in a scene,
 * usually on the main camera. 2D sounds (`spatialBlend` 0, the default) play the same
 * without one.
 */
export class AudioListener extends Behaviour {
  static readonly disallowMultiple = true;

  override _attach(): void {
    const entity = this.gameObject.entity;
    if (!entity.audiolistener) entity.addComponent('audiolistener');
  }

  override _enabledChanged(): void {
    const listener = this.gameObject.entity.audiolistener;
    if (listener) listener.enabled = this._enabled;
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed) this.gameObject.entity.removeComponent('audiolistener');
  }
}

const MAIN = 'clip';
const ONE_SHOT = 'oneShot';
const warnedNoListener = new WeakSet<object>();

/**
 * Plays an `AudioClip`, in 2D (music, interface sounds) or at its GameObject's position
 * in 3D. Unity: `AudioSource`, with the same members and defaults: `playOnAwake` true,
 * `volume` 1, `pitch` 1, `spatialBlend` 0 (2D), `minDistance` 1, `maxDistance` 500.
 *
 *   const source = gameObject.addComponent(AudioSource);
 *   source.clip = await Assets.loadAudioClip(shotUrl);
 *   source.play();                    // or source.playOneShot(clip) for overlapping effects
 *
 * Differences from Unity:
 * - `spatialBlend` is either 2D or 3D: below 0.5 counts as 0, from 0.5 as 1.
 * - Browsers start sound only after the player has clicked or pressed a key once; a
 *   sound played before that starts when they do (PlayCanvas waits for it).
 * - `isPlaying` reports the main clip only, not `playOneShot` sounds.
 * - Without a sound device (a headless engine, tests) nothing is heard, but `isPlaying`,
 *   `time` and the rest behave as if it were playing, so scripts can be tested.
 */
export class AudioSource extends Behaviour {
  /** Start playing `clip` when this component is enabled (and when the scene starts). Same as Unity. */
  playOnAwake = true;

  private _clip: AudioClip | null = null;
  private _volume = 1;
  private _pitch = 1;
  private _loop = false;
  private _mute = false;
  private _spatialBlend = 0;
  private _minDistance = 1;
  private _maxDistance = 500;
  /** Without a sound device: when the clip started (unscaled seconds), or null when stopped. */
  private silentStart: number | null = null;
  private silentPausedAt: number | null = null;

  /** The PlayCanvas sound component. An escape hatch. */
  get pcSound(): pc.SoundComponent {
    const entity = this.gameObject.entity;
    return entity.sound ?? (entity.addComponent('sound', { positional: false }) as pc.SoundComponent);
  }

  override _attach(): void {
    this.apply();
  }

  override _enable(): void {
    if (this.playOnAwake && this._clip) this.play();
  }

  override _disable(): void {
    this.stop();
  }

  override _destroy(): void {
    if (!this.gameObject.isDestroyed) this.gameObject.entity.removeComponent('sound');
  }

  /** True when sound can actually be heard on this machine. */
  private get audible(): boolean {
    const engine = currentEngine();
    return !engine.isHeadless && engine.app.soundManager?.context != null;
  }

  /** The clip `play()` plays. Same as Unity. */
  get clip(): AudioClip | null {
    return this._clip;
  }

  set clip(value: AudioClip | null) {
    this.stop();
    this._clip = value;
    this.apply();
  }

  /** 0 to 1. Same as Unity. */
  get volume(): number {
    return this._volume;
  }

  set volume(value: number) {
    this._volume = Math.min(1, Math.max(0, value));
    this.apply();
  }

  /** Playback speed: 2 is an octave up and twice as fast. Same as Unity. */
  get pitch(): number {
    return this._pitch;
  }

  set pitch(value: number) {
    this._pitch = value;
    this.apply();
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(value: boolean) {
    this._loop = value;
    this.apply();
  }

  /** Silences the source without stopping it. Same as Unity. */
  get mute(): boolean {
    return this._mute;
  }

  set mute(value: boolean) {
    this._mute = value;
    this.apply();
  }

  /** 0 = 2D (the same everywhere), 1 = 3D (from this object's position). Here only those two: see the class comment. */
  get spatialBlend(): number {
    return this._spatialBlend;
  }

  set spatialBlend(value: number) {
    this._spatialBlend = Math.min(1, Math.max(0, value));
    this.apply();
  }

  /** 3D: within this distance the sound is at full volume. Same as Unity. */
  get minDistance(): number {
    return this._minDistance;
  }

  set minDistance(value: number) {
    this._minDistance = value;
    this.apply();
  }

  /** 3D: beyond this distance it gets no quieter. Same as Unity. */
  get maxDistance(): number {
    return this._maxDistance;
  }

  set maxDistance(value: number) {
    this._maxDistance = value;
    this.apply();
  }

  /** True while the clip plays (not counting `playOneShot` sounds). */
  get isPlaying(): boolean {
    if (this.audible) return this.pcSound.slot(MAIN)?.isPlaying ?? false;
    if (this.silentStart === null || this.silentPausedAt !== null) return false;
    const elapsed = this.silentElapsed();
    if (elapsed < 0) return false; // a delayed start that has not come yet
    if (this._loop || !this._clip) return true;
    return elapsed < this._clip.length / Math.max(this._pitch, 1e-6);
  }

  /** Seconds into the clip. Same as Unity. */
  get time(): number {
    if (this.audible) return this.pcSound.slot(MAIN)?.instances[0]?.currentTime ?? 0;
    if (this.silentStart === null) return 0;
    const played = Math.max(0, this.silentElapsed()) * this._pitch;
    const length = this._clip?.length ?? 0;
    return this._loop && length > 0 ? played % length : Math.min(played, length);
  }

  private silentElapsed(): number {
    const now = this.silentPausedAt ?? currentEngine().time.unscaledTime;
    return now - (this.silentStart ?? now);
  }

  /** Plays `clip` from the start (after `delay` seconds). Same as Unity's `Play(delay)`. */
  play(delay = 0): void {
    if (!this._clip) {
      console.warn(`AudioSource on "${this.name}" has no clip to play. Set source.clip first.`);
      return;
    }
    this.warnIfNoListener();
    // Silent bookkeeping starts `delay` seconds from now, so `isPlaying` waits for it too.
    this.silentStart = currentEngine().time.unscaledTime + Math.max(0, delay);
    this.silentPausedAt = null;
    if (!this.audible) return;
    const start = () => {
      if (this.isDestroyed || this.silentStart === null) return;
      const slot = this.pcSound.slot(MAIN);
      slot?.stop();
      slot?.play();
    };
    // Unity times the delay on the audio clock, not game time, so `Time.timeScale` does not stretch it.
    if (delay > 0) setTimeout(start, delay * 1000);
    else start();
  }

  stop(): void {
    this.silentStart = null;
    this.silentPausedAt = null;
    if (this.audible) this.gameObject.entity.sound?.slot(MAIN)?.stop();
  }

  pause(): void {
    if (this.silentStart !== null && this.silentPausedAt === null)
      this.silentPausedAt = currentEngine().time.unscaledTime;
    if (this.audible) this.pcSound.slot(MAIN)?.pause();
  }

  /** Same as Unity's `UnPause()`. */
  unPause(): void {
    if (this.silentPausedAt !== null && this.silentStart !== null) {
      this.silentStart += currentEngine().time.unscaledTime - this.silentPausedAt;
      this.silentPausedAt = null;
    }
    if (this.audible) this.pcSound.slot(MAIN)?.resume();
  }

  /** Plays `clip` once, overlapping whatever else this source plays. Same as Unity. */
  playOneShot(clip: AudioClip, volumeScale = 1): void {
    this.warnIfNoListener();
    if (!this.audible) return;
    const slot =
      this.pcSound.slot(ONE_SHOT) ?? this.pcSound.addSlot(ONE_SHOT, { overlap: true, autoPlay: false, loop: false });
    if (!slot) return;
    slot.asset = clip.pcAsset.id;
    slot.volume = volumeScale;
    slot.play();
  }

  /**
   * Plays a clip at a point in the world, from a temporary GameObject that removes itself
   * when done. Same as Unity's `AudioSource.PlayClipAtPoint`.
   */
  static playClipAtPoint(clip: AudioClip, position: Vector3, volume = 1): void {
    const holder = new GameObject('One shot audio');
    holder.transform.position = position;
    const source = holder.addComponent(AudioSource);
    source.spatialBlend = 1;
    source.volume = volume;
    source.clip = clip;
    source.play();
    destroy(holder, clip.length + 0.1);
  }

  /** Pushes the settings into PlayCanvas. */
  private apply(): void {
    const sound = this.pcSound;
    sound.positional = this._spatialBlend >= 0.5;
    sound.refDistance = this._minDistance;
    sound.maxDistance = this._maxDistance;
    sound.distanceModel = pc.DISTANCE_INVERSE; // the nearest to Unity's logarithmic rolloff
    sound.volume = this._mute ? 0 : this._volume;
    sound.pitch = this._pitch;
    const slot = sound.slot(MAIN) ?? sound.addSlot(MAIN, { loop: this._loop, autoPlay: false, overlap: false });
    if (slot) {
      slot.asset = this._clip?.pcAsset.id ?? null;
      slot.loop = this._loop;
    }
  }

  private warnIfNoListener(): void {
    const engine = currentEngine();
    if (this._spatialBlend < 0.5 || warnedNoListener.has(engine) || findAnyObjectByType(AudioListener)) return;
    warnedNoListener.add(engine);
    console.warn(
      'A 3D AudioSource is playing, but the scene has no AudioListener, so it is heard from the origin. ' +
        'Add one to the main camera: camera.gameObject.addComponent(AudioListener).',
    );
  }

  override _copyFrom(source: this): void {
    super._copyFrom(source, (value) => value);
    this._clip = source._clip;
    this._volume = source._volume;
    this._pitch = source._pitch;
    this._loop = source._loop;
    this._mute = source._mute;
    this._spatialBlend = source._spatialBlend;
    this._minDistance = source._minDistance;
    this._maxDistance = source._maxDistance;
    this.apply();
  }
}

nameType(AudioSource, 'AudioSource');
nameType(AudioListener, 'AudioListener');
