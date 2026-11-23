/**
 * Minimal aerodynamic test-car proxy for the wet-road scene.
 *
 * Deliberately simple: one lofted fastback body that can roll / pitch on its springs and
 * four articulated wheels (steer + spin + suspension travel). All attention stays on the
 * wet-asphalt physics, aquaplaning and tire spray.
 */
import * as THREE from 'three/webgpu';

export interface TestCarRig {
  /** Root – bind to the chassis rigid body. Origin at the centre of mass height reference. */
  object: THREE.Group;
  /** Sprung body: receives roll / pitch from the suspension solver. */
  body: THREE.Group;
  /** Wheel pivots in order FL, FR, RL, RR (rig space, forward = -Z). */
  wheels: THREE.Group[];
  wheelRadius: number;
  /** Wheel hub rest positions relative to the chassis. */
  hardPoints: THREE.Vector3[];
  halfExtents: THREE.Vector3;
  mass: number;
  /** Brake / tail lamps emissive intensity 0..1. */
  setBrake(amount: number): void;
  /** Headlights on/off. */
  setHeadlights(on: boolean): void;
  /** World position of the rear bumper centre (wake-convergence anchor). */
  rearBumper: THREE.Vector3;
}

function bodyGeometry(): THREE.BufferGeometry {
  // Side profile stations: z (front negative), roof height, belt half-width, floor height.
  const stations: Array<[number, number, number, number]> = [
    [-2.28, 0.46, 0.62, 0.30], [-2.15, 0.62, 0.80, 0.22], [-1.6, 0.74, 0.90, 0.18], [-0.95, 0.82, 0.93, 0.17],
    [-0.45, 1.18, 0.90, 0.17], [0.25, 1.30, 0.88, 0.17], [0.95, 1.24, 0.89, 0.17], [1.65, 0.98, 0.90, 0.18],
    [2.1, 0.86, 0.86, 0.22], [2.26, 0.7, 0.74, 0.32],
  ];
  const ring = 20;
  const positions: number[] = [], indices: number[] = [];
  stations.forEach(([z, roof, half, floor]) => {
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      // Super-ellipse cross-section: flat floor, tumblehome cabin.
      const c = Math.cos(a), s = Math.sin(a);
      const e = 0.42;
      const x = Math.sign(c) * Math.pow(Math.abs(c), e) * half * (s > 0 ? 1 - 0.22 * s * s * Math.max(0, (roof - 0.82) / 0.5) : 1);
      const mid = (roof + floor) / 2, hh = (roof - floor) / 2;
      const y = mid + Math.sign(s) * Math.pow(Math.abs(s), e) * hh;
      positions.push(x, y, z);
    }
  });
  for (let j = 0; j < stations.length - 1; j++) for (let i = 0; i < ring; i++) {
    const a = j * ring + i, b = j * ring + ((i + 1) % ring), c = a + ring, d = b + ring;
    indices.push(a, c, b, b, c, d);
  }
  // End caps.
  const capFront = positions.length / 3; positions.push(0, 0.42, stations[0][0] - 0.04);
  const capRear = positions.length / 3; positions.push(0, 0.52, stations[stations.length - 1][0] + 0.04);
  const last = (stations.length - 1) * ring;
  for (let i = 0; i < ring; i++) {
    indices.push(capFront, i, (i + 1) % ring);
    indices.push(capRear, last + ((i + 1) % ring), last + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export function createTestCar(color: THREE.ColorRepresentation = 0xb3121a): TestCarRig {
  const object = new THREE.Group();
  object.name = 'rig:test-car';
  const body = new THREE.Group();
  object.add(body);

  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05 });
  const shell = new THREE.Mesh(bodyGeometry(), paint);
  shell.castShadow = true; shell.receiveShadow = true;
  body.add(shell);

  // Greenhouse: a dark glass wedge sunk into the shell (side profile extruded across the cabin).
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x05080b, roughness: 0.04, metalness: 0.3, clearcoat: 1 });
  const profile = new THREE.Shape();
  profile.moveTo(-0.62, 0.86); profile.lineTo(-0.2, 1.3); profile.lineTo(0.92, 1.265); profile.lineTo(1.62, 0.985); profile.lineTo(1.62, 0.86); profile.closePath();
  const cabinGeo = new THREE.ExtrudeGeometry(profile, { depth: 1.5, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
  cabinGeo.translate(0, 0, -0.75);
  cabinGeo.rotateY(-Math.PI / 2); // profile X → rig Z (front = -Z)
  const cabin = new THREE.Mesh(cabinGeo, glass);
  cabin.castShadow = true;
  body.add(cabin);

  const lampGeo = new THREE.BoxGeometry(0.34, 0.09, 0.05);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x250000, emissive: 0xff1408, emissiveIntensity: 1.6, roughness: 0.3 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 0, roughness: 0.2 });
  for (const sx of [-0.56, 0.56]) {
    const tail = new THREE.Mesh(lampGeo, tailMat); tail.position.set(sx, 0.74, 2.27); body.add(tail);
    const head = new THREE.Mesh(lampGeo, headMat); head.position.set(sx, 0.6, -2.26); body.add(head);
  }
  const headlight = new THREE.SpotLight(0xfff0d8, 0, 70, 0.5, 0.6, 1.4);
  headlight.position.set(0, 0.62, -2.2);
  headlight.target.position.set(0, 0.1, -20);
  body.add(headlight, headlight.target);

  const wheelRadius = 0.34;
  const tyre = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.86, metalness: 0 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.3, metalness: 0.9 });
  const tyreGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.26, 28).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(wheelRadius * 0.62, wheelRadius * 0.62, 0.27, 10).rotateZ(Math.PI / 2);
  const hardPoints = [
    new THREE.Vector3(-0.82, 0.36, -1.42), new THREE.Vector3(0.82, 0.36, -1.42),
    new THREE.Vector3(-0.82, 0.36, 1.38), new THREE.Vector3(0.82, 0.36, 1.38),
  ];
  const wheels = hardPoints.map((p) => {
    const pivot = new THREE.Group();
    pivot.position.copy(p);
    const spin = new THREE.Group();
    spin.name = 'spin';
    const t = new THREE.Mesh(tyreGeo, tyre); t.castShadow = true;
    const r = new THREE.Mesh(rimGeo, rim);
    spin.add(t, r);
    pivot.add(spin);
    object.add(pivot);
    return pivot;
  });

  return {
    object, body, wheels, wheelRadius, hardPoints,
    halfExtents: new THREE.Vector3(0.9, 0.38, 2.2),
    mass: 1450,
    rearBumper: new THREE.Vector3(0, 0.45, 2.3),
    setBrake(amount) { tailMat.emissiveIntensity = 1.6 + amount * 9; },
    setHeadlights(on) { headMat.emissiveIntensity = on ? 14 : 0; headlight.intensity = on ? 900 : 0; },
  };
}
