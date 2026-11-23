import * as THREE from 'three/webgpu';
import { TSL as t, type N } from '../../engine/tsl';
import { spriteNoise } from '../../engine/noise';

export interface ScuffContact {
  /** Full length and width of the rubbing patch, in world metres. */
  lengthM: number;
  widthM: number;
  /** 0–1. Light rubbing dulls lacquer; deeper rubbing reveals primer and metal. */
  strength: number;
  /** Maximum distance from the reported contact to a rendered triangle. */
  reachM?: number;
  /** Triangle index from a Three.js raycast. A physics-only contact may omit it. */
  faceIndex?: number | null;
  materialIndex?: number;
  instanceId?: number;
}

/** Eight contact marks for a painted mesh or instanced draw. Owns only its material clone.
 * Use an immutable local position attribute on a deforming mesh. */
export class PaintWear {
  readonly material: THREE.MeshStandardNodeMaterial;
  private readonly centers = t.uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4()), 'vec4');
  private readonly along = t.uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4()), 'vec4');
  private readonly across = t.uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4()), 'vec4');
  private readonly depth = t.uniformArray(Array.from({ length: 8 }, () => new THREE.Vector4()), 'vec4');
  private readonly active = t.uniform(0, 'int');
  private next = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private morphInstance?: THREE.Mesh;
  private readonly query = new THREE.Vector3();
  private readonly triangle = new THREE.Triangle();
  private readonly point = new THREE.Vector3();
  private readonly bary = new THREE.Vector3();
  private readonly ab = new THREE.Vector3();
  private readonly ac = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();
  private readonly dualB = new THREE.Vector3();
  private readonly dualC = new THREE.Vector3();

  get count(): number { return this.active.value; }

  constructor(original: THREE.MeshStandardNodeMaterial, private readonly restAttribute = 'position', restNormalAttribute = 'normal') {
    this.material = original.clone();
    const material = this.material;
    const rest = t.attribute(restAttribute, 'vec3').toVarying('paintWearRest');
    const faceNormal = t.attribute(restNormalAttribute, 'vec3').toVarying('paintWearNormal');
    const instance = t.float(t.instanceIndex).toVarying('paintWearInstance');
    const wear = t.Fn(() => {
      const mask = t.vec3(0).toVar();
      t.Loop({ start: t.int(0), end: this.active, type: 'int', condition: '<' }, ({ i }: N) => {
        const center = this.centers.element(i), u = this.along.element(i), v = this.across.element(i), plane = this.depth.element(i);
        const delta = rest.sub(center.xyz);
        const x = t.dot(delta, u.xyz), y = t.dot(delta, v.xyz);
        const radius = t.length(t.vec2(x, y));
        t.If(radius.lessThan(1.15).and(t.abs(t.dot(delta, plane.xyz)).lessThan(plane.w))
          .and(t.dot(faceNormal, plane.xyz).greaterThan(0.18)).and(t.abs(instance.sub(u.w)).lessThan(0.25)), () => {
          const seed = t.float(i).mul(3.69);
          const grain = spriteNoise(t.vec2(x.mul(3.8).add(seed), y.mul(7.5)), 0);
          const grit = spriteNoise(t.vec2(x.mul(12.0), y.mul(19).add(seed)), 1);
          const edge = radius.add(grain.sub(0.5).mul(0.29));
          const rubbed = t.smoothstep(0.56, 1.08, edge).oneMinus().mul(center.w);
          // A few abrasive ridges can cut through primer in the same stroke.
          const striae = y.mul(16).add(grain.mul(3.4)).add(x.mul(0.58)).sin().mul(0.5).add(0.5);
          const ridges = spriteNoise(t.vec2(x.mul(1.1).add(seed), y.mul(12.7)), 1);
          const grooves = striae.mul(0.36).add(ridges.mul(0.46)).add(0.38);
          const cut = rubbed.mul(grooves).mul(grit.mul(0.68).add(0.70)).mul(t.smoothstep(0.18, 0.49, grain).mul(0.50).add(0.50));
          mask.assign(t.max(mask, t.vec3(rubbed, t.smoothstep(0.26, 0.57, cut), t.smoothstep(0.55, 0.81, cut))));
        });
      });
      return mask;
    })().toVar();
    const primer = t.vec3(0.108, 0.104, 0.096), metal = t.vec3(0.42, 0.44, 0.45);
    // Base paint can be tinted by a vertex colour or an instance. Exposed
    // primer and metal replace that final pigment while retaining its opacity.
    const setupBase = material.setupDiffuseColor;
    material.setupDiffuseColor = function (builder) {
      setupBase.call(this, builder);
      t.diffuseColor.rgb.assign(t.mix(t.mix(t.diffuseColor.rgb, primer, wear.y), metal, wear.z));
    };
    material.roughnessNode = t.mix(t.mix(material.roughnessNode ?? t.materialRoughness, 0.70, wear.x), 0.36, wear.z);
    material.metalnessNode = t.mix(t.mix(material.metalnessNode ?? t.materialMetalness, 0.04, wear.y), 0.91, wear.z);
    const coat = material as THREE.MeshPhysicalNodeMaterial;
    if (coat.isMeshPhysicalNodeMaterial && (coat.clearcoat > 0 || coat.clearcoatNode)) {
      coat.clearcoatNode = (coat.clearcoatNode ?? t.materialClearcoat).mul(wear.x.mul(1.8).clamp(0, 1).oneMinus());
      coat.clearcoatRoughnessNode = t.mix(coat.clearcoatRoughnessNode ?? t.materialClearcoatRoughness, 0.65, wear.x);
    }
  }

  /** Project a render- or physics-world contact onto the nearest painted triangle. */
  stamp(mesh: THREE.Mesh, hit: THREE.Vector3, slide: THREE.Vector3, contact: ScuffContact): boolean {
    const { lengthM, widthM, strength, materialIndex = 0, instanceId = 0, reachM = 0.12 } = contact;
    const faceIndex = contact.faceIndex ?? undefined;
    if (!(lengthM > 0 && widthM > 0 && strength > 0 && reachM >= 0) ||
      !Number.isFinite(lengthM + widthM + strength + reachM)) return false;
    mesh.updateWorldMatrix(true, false);
    const instances = mesh as THREE.InstancedMesh;
    let posed = mesh;
    if (instances.isInstancedMesh) {
      if (!Number.isInteger(contact.instanceId) || instanceId < 0 || instanceId >= instances.count) return false;
      instances.getMatrixAt(instanceId, this.matrix);
      this.matrix.premultiply(mesh.matrixWorld);
      if (instances.morphTexture && mesh.geometry.morphAttributes.position?.length) {
        if (this.morphInstance?.geometry !== mesh.geometry) this.morphInstance = new THREE.Mesh(mesh.geometry, mesh.material);
        instances.getMorphAt(instanceId, this.morphInstance);
        posed = this.morphInstance;
      }
    } else {
      if (instanceId !== 0) return false;
      // Attached bones and the inverse bind matrix may have changed since the last draw.
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.updateMatrixWorld(true);
      this.matrix.copy(mesh.matrixWorld);
    }
    const geometry = mesh.geometry, positions = geometry.getAttribute('position'), rest = geometry.getAttribute(this.restAttribute);
    if (!positions || !rest || !this.matrix.determinant()) return false;
    this.inverse.copy(this.matrix).invert();
    this.query.copy(hit).applyMatrix4(this.inverse);
    const reach = reachM * this.inverse.getMaxScaleOnAxis() * Math.sqrt(3);
    const { a, b, c } = this.triangle, q = this.query, indices = geometry.index;
    const length = indices?.count ?? positions.count;
    if (faceIndex !== undefined && (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex * 3 + 2 >= length)) return false;
    const grouped = Array.isArray(mesh.material);
    const groupCount = grouped ? geometry.groups.length : 1;
    let best = reachM * reachM, ia = -1, ib = -1, ic = -1, nearestMaterial = -1;
    for (let g = 0; g < groupCount; g++) {
      const group = grouped ? geometry.groups[g] : undefined;
      const surface = Array.isArray(mesh.material) ? mesh.material[group?.materialIndex ?? 0] : mesh.material;
      if (!surface?.visible) continue;
      const start = Math.max(group?.start ?? 0, geometry.drawRange.start);
      const end = Math.min(group ? group.start + group.count : length, length, geometry.drawRange.start + geometry.drawRange.count);
      // Raycaster reports floor(index offset / 3), including for partial draw ranges.
      const first = faceIndex === undefined ? start : faceIndex * 3 + start % 3;
      if (first < start) continue;
      const hi = faceIndex === undefined ? end : Math.min(end, first + 3);
      for (let i = first; i + 2 < hi; i += 3) {
        const i0 = indices?.getX(i) ?? i, i1 = indices?.getX(i + 1) ?? i + 1, i2 = indices?.getX(i + 2) ?? i + 2;
        posed.getVertexPosition(i0, a); posed.getVertexPosition(i1, b); posed.getVertexPosition(i2, c);
        if (q.x + reach < Math.min(a.x, b.x, c.x) || q.x - reach > Math.max(a.x, b.x, c.x) ||
            q.y + reach < Math.min(a.y, b.y, c.y) || q.y - reach > Math.max(a.y, b.y, c.y) ||
            q.z + reach < Math.min(a.z, b.z, c.z) || q.z - reach > Math.max(a.z, b.z, c.z)) continue;
        a.applyMatrix4(this.matrix); b.applyMatrix4(this.matrix); c.applyMatrix4(this.matrix);
        this.triangle.closestPointToPoint(hit, this.point);
        const d = hit.distanceToSquared(this.point);
        if (d <= best && this.triangle.getBarycoord(this.point, this.bary)) {
          ia = i0; ib = i1; ic = i2; best = d;
          nearestMaterial = group?.materialIndex ?? 0;
        }
      }
    }
    if (ia < 0 || nearestMaterial !== materialIndex) return false;
    posed.getVertexPosition(ia, a).applyMatrix4(this.matrix);
    posed.getVertexPosition(ib, b).applyMatrix4(this.matrix);
    posed.getVertexPosition(ic, c).applyMatrix4(this.matrix);
    this.triangle.closestPointToPoint(hit, this.point);
    this.triangle.getBarycoord(this.point, this.bary);
    this.triangle.getNormal(this.normal);
    this.tangent.copy(slide).addScaledVector(this.normal, -slide.dot(this.normal));
    if (this.tangent.lengthSq() < 1e-8) this.tangent.subVectors(b, a);
    this.tangent.normalize();
    this.lateral.crossVectors(this.normal, this.tangent);
    this.ab.subVectors(b, a); this.ac.subVectors(c, a);
    const ub = this.ab.dot(this.tangent) * 2 / lengthM, uc = this.ac.dot(this.tangent) * 2 / lengthM;
    const vb = this.ab.dot(this.lateral) * 2 / widthM, vc = this.ac.dot(this.lateral) * 2 / widthM;
    // Pull the world-space metric back to the rest triangle. This keeps the
    // footprint in metres on scaled props and attached through a later dent.
    a.fromBufferAttribute(rest, ia); b.fromBufferAttribute(rest, ib); c.fromBufferAttribute(rest, ic);
    this.ab.subVectors(b, a); this.ac.subVectors(c, a);
    this.normal.crossVectors(this.ab, this.ac);
    const area = this.normal.length();
    if (area < 1e-10) return false;
    this.normal.divideScalar(area);
    this.dualB.crossVectors(this.ac, this.normal).divideScalar(area);
    this.dualC.crossVectors(this.normal, this.ab).divideScalar(area);
    const slot = this.next;
    this.point.copy(a).addScaledVector(this.ab, this.bary.y).addScaledVector(this.ac, this.bary.z);
    this.centers.array[slot].set(this.point.x, this.point.y, this.point.z, Math.min(1, strength));
    this.tangent.copy(this.dualB).multiplyScalar(ub).addScaledVector(this.dualC, uc);
    this.along.array[slot].set(this.tangent.x, this.tangent.y, this.tangent.z, instanceId);
    this.lateral.copy(this.dualB).multiplyScalar(vb).addScaledVector(this.dualC, vc);
    this.across.array[slot].set(this.lateral.x, this.lateral.y, this.lateral.z, 0);
    const thickness = Math.min(widthM * 0.55, 0.065) * this.inverse.getMaxScaleOnAxis();
    this.depth.array[slot].set(this.normal.x, this.normal.y, this.normal.z, thickness);
    this.next = (slot + 1) % this.centers.array.length;
    this.active.value = Math.min(this.centers.array.length, this.active.value + 1);
    return true;
  }

  clear(): void { this.active.value = this.next = 0; }
  dispose(): void { this.material.dispose(); }
}
