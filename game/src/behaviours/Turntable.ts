import { MonoBehaviour, Time, Vector3 } from '@synergy/engine';

/** Turns its object slowly about the world's up axis: a menu backdrop. Keeps turning while the game is paused. */
export class Turntable extends MonoBehaviour {
  degreesPerSecond = 12;

  update() {
    this.transform.rotate(Vector3.up, this.degreesPerSecond * Time.unscaledDeltaTime);
  }
}
