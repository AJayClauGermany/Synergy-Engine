import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as pc from 'playcanvas';
import { AudioClip, AudioListener, AudioSource, Engine, GameObject, instantiate } from '../src';

let engine: Engine;

beforeEach(() => {
  engine = Engine.createHeadless();
});

afterEach(() => {
  engine.dispose();
});

/** A clip of `seconds` with no sound data: a headless engine plays it silently. */
function clip(seconds: number): AudioClip {
  const asset = new pc.Asset('beep', 'audio', { url: '' });
  asset.resource = { duration: seconds } as unknown as pc.Sound;
  return new AudioClip('beep', asset);
}

describe('AudioSource', () => {
  test("has Unity's defaults and pushes its settings into PlayCanvas", () => {
    const source = new GameObject('Speaker').addComponent(AudioSource);
    expect(source.playOnAwake).toBe(true);
    expect([source.volume, source.pitch, source.spatialBlend, source.minDistance, source.maxDistance]).toEqual([
      1, 1, 0, 1, 500,
    ]);
    source.spatialBlend = 1;
    source.volume = 2; // clamped, as in Unity
    source.minDistance = 3;
    expect(source.volume).toBe(1);
    expect(source.pcSound.positional).toBe(true);
    expect(source.pcSound.refDistance).toBe(3);
    source.mute = true;
    expect(source.pcSound.volume).toBe(0);
  });

  test('plays for the length of its clip, and keeps time through pause', () => {
    const source = new GameObject('Speaker').addComponent(AudioSource);
    source.clip = clip(1);
    source.play();
    engine.stepSeconds(0.5);
    expect(source.isPlaying).toBe(true);
    expect(source.time).toBeCloseTo(0.5, 1);
    source.pause();
    engine.stepSeconds(2);
    expect(source.isPlaying).toBe(false);
    source.unPause();
    expect(source.time).toBeCloseTo(0.5, 1);
    engine.stepSeconds(0.6);
    expect(source.isPlaying).toBe(false);
    source.loop = true;
    source.play();
    engine.stepSeconds(2.25);
    expect(source.isPlaying).toBe(true);
    expect(source.time).toBeCloseTo(0.25, 1);
    source.stop();
    expect(source.isPlaying).toBe(false);
  });

  test('play(delay) waits; playOnAwake starts with the object; disabling stops it', () => {
    const delayed = new GameObject('Delayed').addComponent(AudioSource);
    delayed.clip = clip(5);
    delayed.play(1);
    engine.stepSeconds(0.5);
    expect(delayed.isPlaying).toBe(false);
    engine.stepSeconds(1);
    expect(delayed.isPlaying).toBe(true);

    const prefab = new GameObject('Music');
    prefab.setActive(false);
    const music = prefab.addComponent(AudioSource);
    music.clip = clip(5);
    prefab.setActive(true);
    expect(music.isPlaying).toBe(true);
    music.enabled = false;
    expect(music.isPlaying).toBe(false);
  });

  test('a clone keeps the settings', () => {
    const source = new GameObject('Speaker').addComponent(AudioSource);
    source.clip = clip(2);
    source.volume = 0.25;
    source.loop = true;
    const copy = instantiate(source);
    expect(copy.clip).toBe(source.clip);
    expect(copy.volume).toBe(0.25);
    expect(copy.loop).toBe(true);
  });

  test('a 3D sound with no AudioListener in the scene says where to put one', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const source = new GameObject('Speaker').addComponent(AudioSource);
    source.spatialBlend = 1;
    source.clip = clip(1);
    source.play();
    expect(warn.mock.calls.flat().join(' ')).toContain('addComponent(AudioListener)');
    warn.mockClear();
    new GameObject('Main Camera').addComponent(AudioListener);
    source.play();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
