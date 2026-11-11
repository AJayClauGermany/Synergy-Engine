import { Input, KeyCode, Mathf, MonoBehaviour, Quaternion, Time, type Transform, Vector3 } from '@synergy/engine';

/**
 * A strategy-game camera. This object sits on the ground at the point being looked at;
 * the camera is its child, raised and pulled back.
 *
 *   WASD / arrows  pan        Q / E  rotate        mouse wheel  zoom
 */
export class CameraRig extends MonoBehaviour {
  panSpeed = 8;
  rotateSpeed = 90;
  zoomStep = 1.5;
  minDistance = 5;
  maxDistance = 22;
  /** Angle above the horizon, in degrees. */
  pitch = 55;
  distance = 13;
  /** How far the focus point may wander from the origin on X and Z. */
  bounds = 6;

  camera: Transform | null = null;
  private yaw = 0;
  private targetDistance = this.distance;

  start() {
    this.targetDistance = this.distance;
    this.apply();
  }

  update() {
    // Unscaled time: the camera keeps working while the game is paused or sped up.
    const dt = Time.unscaledDeltaTime;

    const turn = (Input.getKey(KeyCode.E) ? 1 : 0) - (Input.getKey(KeyCode.Q) ? 1 : 0);
    this.yaw += turn * this.rotateSpeed * dt;

    const pan = new Vector3(Input.getAxis('Horizontal'), 0, -Input.getAxis('Vertical'));
    if (pan.sqrMagnitude > 0) {
      // Faster when zoomed out, so panning feels the same on screen.
      const speed = this.panSpeed * (this.distance / 13);
      const moved = this.transform.position.add(
        Quaternion.euler(0, this.yaw, 0)
          .rotate(pan)
          .mul(speed * dt),
      );
      this.transform.position = new Vector3(
        Mathf.clamp(moved.x, -this.bounds, this.bounds),
        0,
        Mathf.clamp(moved.z, -this.bounds, this.bounds),
      );
    }

    this.targetDistance = Mathf.clamp(
      this.targetDistance - Input.mouseScrollDelta.y * this.zoomStep,
      this.minDistance,
      this.maxDistance,
    );
    this.distance = Mathf.lerp(this.distance, this.targetDistance, 1 - Math.exp(-12 * dt));
  }

  lateUpdate() {
    this.apply();
  }

  private apply() {
    this.transform.rotation = Quaternion.euler(0, this.yaw, 0);
    if (!this.camera) return;
    const radians = this.pitch * Mathf.deg2Rad;
    this.camera.localPosition = new Vector3(0, Math.sin(radians) * this.distance, Math.cos(radians) * this.distance);
    this.camera.lookAt(this.transform.position);
  }
}
