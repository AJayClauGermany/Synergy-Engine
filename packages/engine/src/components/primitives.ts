import { GameObject } from '../core/GameObject';
import { factories, PrimitiveType } from '../core/hooks';
import { BoxCollider, CapsuleCollider, SphereCollider } from '../physics/Collider';
import { Vector3 } from '../math/Vector3';
import { Mesh, MeshFilter, MeshRenderer } from './rendering';

const names: Record<PrimitiveType, string> = {
  [PrimitiveType.Sphere]: 'Sphere',
  [PrimitiveType.Capsule]: 'Capsule',
  [PrimitiveType.Cylinder]: 'Cylinder',
  [PrimitiveType.Cube]: 'Cube',
  [PrimitiveType.Plane]: 'Plane',
  [PrimitiveType.Quad]: 'Quad',
};

/**
 * Implements `GameObject.createPrimitive`. Plane and Quad get a flat BoxCollider where
 * Unity would use a MeshCollider, which does not exist here.
 */
factories.createPrimitive = (type: PrimitiveType): GameObject => {
  const gameObject = new GameObject(names[type]);
  gameObject.addComponent(MeshFilter).mesh = Mesh.primitive(type);
  gameObject.addComponent(MeshRenderer);
  switch (type) {
    case PrimitiveType.Sphere:
      gameObject.addComponent(SphereCollider);
      break;
    case PrimitiveType.Capsule:
    case PrimitiveType.Cylinder:
      gameObject.addComponent(CapsuleCollider);
      break;
    case PrimitiveType.Cube:
      gameObject.addComponent(BoxCollider);
      break;
    case PrimitiveType.Plane:
      gameObject.addComponent(BoxCollider).size = new Vector3(10, 0, 10);
      break;
    case PrimitiveType.Quad:
      gameObject.addComponent(BoxCollider).size = new Vector3(1, 1, 0);
      break;
  }
  return gameObject;
};
