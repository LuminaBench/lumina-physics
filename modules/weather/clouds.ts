/**
 * Volumetric clouds: Worley–Perlin density model, Beer–powder lighting with a dual-lobe
 * Henyey–Greenstein phase (silver lining), light-marched self-shadowing and an analytic
 * optical-depth ground shadow.
 *
 * The density field is one shared blueprint (`createCloudModel`) used by:
 *   - the full-resolution sky dome raymarch (temporally jittered, resolved by TRAA),
 *   - the low-resolution reflection / PMREM environment march,
 *   - `cloudShadow(worldPos)` for the ocean, roads, sand and the sun light itself.
 */
import * as THREE from 'three/webgpu';
import { TSL, type N } from '../../engine/tsl';
import { frame, sunlightAtHeight } from '../../engine/frame';
import { bakeCloudNoise } from '../../engine/noise';
import { cloudFireBounce } from '../../engine/shaders/cloud-bounce';
import { ATMOSPHERE } from './atmosphere';

const { Fn, If, Loop, Break, int, float, vec2, vec3, vec4, uniform, texture, texture3D, exp, max, min, mix, smoothstep, sqrt, sin, dot, pow, length } = TSL;

export interface CloudUniforms {
  coverage: N;
  density: N;
  base: N;
  top: N;
  storm: N;
  /** Accumulated wind advection in metres. */
  offset: N;
  /** Reciprocal horizontal size multiplier for cloud formations. */
  frequency: N;
  crownOffset: N;
  billows: N;
  skylightReach: N;
  convection: N;
  erosion: N;
  steps: N;
  lightSteps: N;
  envSteps: N;
  flashPosition: N;
  flashColor: N;
  /** Ambient sky colours used for cloud undersides. */
  visibility: N;
}

export const DEFAULT_CLOUD_EROSION = 0.62;

export function createCloudUniforms(): CloudUniforms {
  return {
    coverage: uniform(0.45),
    density: uniform(1),
    base: uniform(1400),
    top: uniform(4200),
    storm: uniform(0),
    offset: uniform(new THREE.Vector3()),
    frequency: uniform(1),
    crownOffset: uniform(new THREE.Vector2()),
    billows: uniform(0),
    skylightReach: uniform(0),
    convection: uniform(0),
    erosion: uniform(DEFAULT_CLOUD_EROSION),
    steps: uniform(36),
    lightSteps: uniform(4),
    envSteps: uniform(12),
    flashPosition: uniform(new THREE.Vector3(0, 2000, 0)),
    flashColor: uniform(new THREE.Color(0, 0, 0)),
    visibility: uniform(70000),
  };
}

const remap = (x: N, a: N, b: N) => x.sub(a).div(max(b.sub(a), 1e-4)).clamp(0, 1);

const WEATHER_SCALE = 1 / 46000;
const BASE_SCALE = 1 / 5200;
const DETAIL_SCALE = 1 / 780;
const EXTINCTION = 0.024;
const SHADOW_HEIGHTS = [0.14, 0.36, 0.62] as const;
const SHADOW_EXTINCTION = EXTINCTION * 0.16;
const EARTH_CURVE = 1 / (2 * ATMOSPHERE.planetRadius);

export interface CloudModel {
  uniforms: CloudUniforms;
  /** March from the camera along `dir` → vec4(scattered radiance, transmittance). */
  march(origin: N, dir: N, jitter: N, steps: N, atmosphereColor: N, distanceOut?: N, incidentSun?: N): N;
  /** Actual volume sampled by the light march, with optional wake displacement. */
  densityNode(position: N, disturbed?: boolean): N;
  /** CPU condensate density at this world point, from the same noise volumes as the march. */
  sampleDensity(position: THREE.Vector3,time: number): number;
  /** Broad sunlight transmission to a receiver below, inside or above this deck. */
  sunTransmissionAt(receiver: THREE.Vector3, sun: THREE.Vector3, time: number): number;
  /** Sun visibility (0..1) at a world position below the cloud layer. */
  shadow(worldPosition: N): N;
}

// Repeat-wrapped bilinear/trilinear lookup at GPU texel centres. Output storage
// belongs to the model; camera entry probes do not allocate.
function sampleVolume(data: Uint8Array,width: number,height: number,depth: number,
  u: number,v: number,w: number,out: Float64Array): void {
  const tx=u*width-0.5,ty=v*height-0.5,tz=w*depth-0.5;
  const ix=Math.floor(tx),iy=Math.floor(ty),iz=Math.floor(tz);
  const fx=tx-ix,fy=ty-iy,fz=tz-iz;
  out.fill(0);
  for(let z=0;z<(depth>1?2:1);z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){
    const xx=((ix+x)%width+width)%width, yy=((iy+y)%height+height)%height;
    const zz=((iz+z)%depth+depth)%depth;
    const i=4*(xx+width*(yy+height*zz));
    const k=(x?fx:1-fx)*(y?fy:1-fy)*(depth===1?1:z?fz:1-fz)/255;
    for(let c=0;c<4;c++)out[c]+=data[i+c]*k;
  }
}

export interface CloudDistribution {
  /** A high veil of ice crystals uses a narrower forward scattering lobe. */
  readonly iceVeil?:boolean;
  /** Phase in radians, advected with the corresponding deck. */
  readonly life?: {at(x:number,z:number,t:number,upper:boolean):number;node(xz:N,t:N,upper:boolean):N};
  coverageNode(xz:N,time:N,upper:boolean):N;
  coverageAt(x:number,z:number,time:number,upper:boolean):number;
}
export function createCloudModel(u: CloudUniforms, carve?: (position: N) => N, distribution?:CloudDistribution,upper=false): CloudModel {
  const noise = bakeCloudNoise();
  const baseTex = noise.base, detailTex = noise.detail, weatherTex = noise.weather;

  /** Density at noise-space position q = (x, altitude, z). `detailed` adds edge erosion. */
  const densityAt = (q: N, detailed: boolean, disturbed = true): N => Fn(() => {
    const h = q.y.sub(u.base).div(u.top.sub(u.base)).toVar();
    const d = float(0).toVar();
    If(h.greaterThan(0).and(h.lessThan(1)).and(u.coverage.greaterThan(0)), () => {
      // With a linear wind change through an updraft, lateral travel accumulates
      // quadratically. Trace the sample back to its source column on the base.
      const source = q.xz.sub(u.crownOffset.mul(h.mul(h))).toVar();
      const adv = vec3(source.x.add(u.offset.x).mul(u.frequency), q.y, source.y.add(u.offset.z).mul(u.frequency));
      const weather = texture(weatherTex, vec2(adv.x, adv.z).mul(WEATHER_SCALE)).level(0);
      // Coverage: below ~70 % the weather map only *limits* how full a cell can get, so the
      // 3D shape noise carves separate cumulus; toward 100 % it closes into a solid deck.
      const w = weather.r.add(weather.b.sub(0.5).mul(0.18)).clamp(0, 1);
      const regional = distribution?.coverageNode(source,frame.time,upper);
      const rawMap = mix(smoothstep(float(0.74).sub(u.coverage), float(1.2).sub(u.coverage), w).mul(0.88), float(1), smoothstep(0.72, 1.0, u.coverage)).toVar();
      const covMap=regional?rawMap.mul(regional):rawMap;
      // Per-cell vertical development: fair-weather cumulus stay low, storm cells tower.
      const phase = distribution?.life?.node(source,frame.time,upper);
      const developmentBias = phase ? sin(phase).mul(upper?0.11:0.27) : float(0);
      const fray = phase ? TSL.cos(phase).negate().mul(0.5).add(0.5) : undefined;
      const development = max(u.storm, smoothstep(0.26, 0.76, weather.g.mul(0.62).add(weather.b.mul(0.38)))).add(u.convection).add(developmentBias).clamp(0, 1);
      const shapeSample = texture3D(baseTex, adv.mul(BASE_SCALE), 0);
      const lowFbm = dot(shapeSample.gba, vec3(0.625, 0.25, 0.125));
      // Individual growing cells reach different levels within one weather bank.
      // A parent updraft is anchored to a column in XZ. Rounded smaller lobes
      // in that column vary in all three directions and also occlude incident light.
      const plume = float(0).toVar(), lobe = float(0).toVar();
      If(u.billows.greaterThan(0), () => {
        const region = texture(weatherTex, adv.xz.mul(1 / 4700).add(vec2(0.23,-0.41))).level(0);
        plume.assign(smoothstep(0.24,0.65,region.r.mul(0.72).add(region.g.mul(0.28))));
        const detailPos = vec3(adv.x.add(adv.z.mul(0.31)),adv.y.mul(0.82),adv.z.sub(adv.x.mul(0.31)))
          .add(shapeSample.gba.sub(0.45).mul(190)).mul(1 / 980);
        const lobes = texture3D(detailTex, detailPos, 0);
        lobe.assign(smoothstep(0.16,0.76,dot(lobes.rgb,vec3(0.58,0.28,0.14))).sub(0.48));
      });
      const crown = smoothstep(0.18, 0.72, lowFbm);
      const floor = crown.oneMinus().mul(fray ? fray.mul(0.045).add(0.012) : 0.022);
      const simpleTop = mix(0.30, 1.0, development).mul(mix(0.76, 1, crown));
      const topH = mix(simpleTop, mix(0.24,1.0,plume).add(lobe.mul(0.16)).clamp(0.18,1),u.billows);
      const hn = h.sub(floor).div(topH.sub(floor));
      const gradient = smoothstep(0.0, 0.06, h.sub(floor)).mul(smoothstep(1.0, 0.7, hn));
      // Narrow the shape with height → domed cauliflower tops; widen again into a storm anvil.
      const shoulder = smoothstep(0.12, 0.96, hn);
      const covH = covMap.mul(mix(1.0, mix(0.22, 0.55, development), shoulder)).add(u.storm.mul(0.35).mul(smoothstep(0.72, 0.95, h)).mul(covMap));
      const rising = smoothstep(0.015,0.34,h).mul(u.billows);
      const rounded = lobe.mul(0.44).add(plume.sub(0.44).mul(0.23)).mul(rising);
      const shape = remap(shapeSample.r, float(1).sub(lowFbm).mul(0.42), float(1)).add(rounded).mul(gradient);
      const dens = remap(shape, float(1).sub(covH), float(1).sub(covH.mul(0.45))).toVar();
      // Resolve boundary billows along axes independent of the shape volume.
      // The existing Worley channels bend the coordinates within each parent cell.
      const shell = smoothstep(0.65, 0.96, dens).oneMinus();
      If(dens.greaterThan(0.001).and(dens.lessThan(0.96)), () => {
        let modifier = float(0.20);
        if (detailed) {
          const rotated = vec3(dot(adv, vec3(0.8, 0, -0.6)), dot(adv, vec3(-0.36, 0.8, -0.48)),
            dot(adv, vec3(0.48, 0.6, 0.64)));
          const coords = rotated.add(shapeSample.gba.sub(0.45).mul(290)).mul(DETAIL_SCALE);
          const det = texture3D(detailTex, coords.add(vec3(0, frame.time.mul(0.006), 0)), 0);
          const cells = smoothstep(0.21, 0.69, dot(det.rgb, vec3(0.48, 0.34, 0.18)));
          modifier = mix(cells, cells.oneMinus(), h.mul(4).clamp(0, 1)).mul(0.86).add(0.08);
        }
        // Sparse light rays retain more of the envelope to conserve shadow in unresolved billows.
        const threshold = modifier.mul(u.erosion).mul(fray ? fray.mul(0.94).add(0.79) : 1);
        const eroded = remap(dens, threshold, float(1));
        dens.assign(mix(dens, eroded, shell));
      });
      // Storm cells carry far more water: denser, darker bases.
      if (carve && disturbed) {
        const cavity = carve(q);
        // Entrained moisture rolls up along the tunnel rim while the core clears.
        const rim = cavity.mul(float(1).sub(cavity)).mul(4);
        const curls = sin(q.y.mul(0.16).add(q.x.mul(0.047)).add(q.z.mul(0.071)).sub(frame.time.mul(2.3))).mul(0.5).add(0.5);
        // Entrain whole eddies at the boundary while preserving a fully clear
        // centre. Cartesian coordinates keep the wake continuous across bearings.
        const rollingEdge = rim.mul(curls.sub(0.5)).mul(0.46);
        dens.mulAssign(float(1).sub(cavity.add(rollingEdge).clamp(0, 1)));
        If(rim.greaterThan(0.035),()=>{
          const spun=vec3(q.x.mul(0.011).add(q.y.mul(0.018)),q.y.mul(0.023).sub(frame.time.mul(0.04)),q.z.mul(0.014));
          const filament=texture3D(detailTex,spun,0).r;
          const edgeMoisture=rim.mul(smoothstep(0.29, 0.70, filament.mul(0.65).add(curls.mul(0.35)))).mul(0.6);
          dens.addAssign(edgeMoisture.mul(gradient).mul(shape));
        });
      }
      d.assign(dens.mul(u.density).mul(mix(1.0, 2.4, u.storm)));
    });
    return d;
  })();

  const hg = (mu: N, g: number): N => float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5));

  /** Solve altitude(t) = H on the curved earth for a camera below H. */
  const layerDistance = (originY: N, dirY: N, H: N): N => {
    const a = float(1).sub(dirY.mul(dirY)).mul(EARTH_CURVE);
    const c = originY.sub(H);
    return c.mul(-2).div(dirY.add(sqrt(max(dirY.mul(dirY).sub(a.mul(c).mul(4)), 0))).max(1e-5));
  };

  const march = (origin: N, dir: N, jitter: N, steps: N, atmosphereColor: N, distanceOut?: N, incidentSun: N = float(1)): N => Fn(() => {
    const result = vec4(0, 0, 0, 1).toVar();
    const oy = origin.y;
    const curve = float(1).sub(dir.y.mul(dir.y)).mul(EARTH_CURVE);
    const down = dir.y.lessThan(0);
    // Positive near intersection with a shell below the eye. This stable quadratic
    // also handles vertical rays (whose curvature coefficient vanishes).
    const nearBelow = (height: N) => {
      const c = oy.sub(height);
      const discriminant = dir.y.mul(dir.y).sub(curve.mul(c).mul(4));
      return down.and(discriminant.greaterThanEqual(0)).select(
        c.mul(2).div(dir.y.negate().add(sqrt(max(discriminant,0))).max(1e-6)), float(1e7));
    };
    const below = oy.lessThan(u.base), above = oy.greaterThan(u.top);
    const t0 = below.select(layerDistance(oy,dir.y,u.base), above.select(nearBelow(u.top),float(0))).max(0);
    const lowerExit = nearBelow(u.base);
    const upperExit = above.select(dir.y.negate().div(curve.max(1e-8)).sub(t0),layerDistance(oy,dir.y,u.top));
    const t1 = below.select(upperExit,min(upperExit,lowerExit));
    const hitsGround=down.and(dir.y.mul(dir.y).sub(curve.mul(oy).mul(4)).greaterThan(0));
    If(u.coverage.greaterThan(0).and(u.density.greaterThan(0)).and(t0.lessThan(150000)).and(t1.greaterThan(t0)).and(below.and(hitsGround).not()), () => {
      {
        const span = min(t1.sub(t0),30000);
        const inDeck=below.or(above).not();
        // Reserve near samples for the aircraft wake. The remaining distance
        // covers the exterior shell with progressively wider intervals.
        const distanceAt=(f:N)=>{
          const nearSpan=min(span.mul(0.45),150);
          const farFraction=f.sub(0.45).div(0.55).max(0);
          const local=f.lessThan(0.45).select(nearSpan.mul(f.div(0.45)),nearSpan.add(span.sub(nearSpan).mul(farFraction.pow(2))));
          return inDeck.select(local,f.mul(span));
        };
        const sun = frame.sunDirection;
        const mu = dot(dir, sun);
        // Dual-lobe HG: strong forward peak (silver lining) + soft back-scatter.
        const ice=upper&&distribution?.iceVeil;
        const phase = mix(hg(mu, ice?.87:.78), hg(mu, -.22), ice?.26:.42).mul(4*Math.PI)
          .add(hg(mu,.965).mul(4*Math.PI*(ice?.06:.035)));
        // Neighbouring eye-ray samples inside a bank often see the same broad
        // sun shadow. The carved density and transmission remain per sample.
        const lightSteps = inDeck.select(min(u.lightSteps, 2), u.lightSteps);
        const lastLit = float(-1e8).toVar(), lastDensity = float(-1).toVar();
        const shadowDepth = float(0).toVar(), skyAccess = float(1).toVar();
        const transmittance = float(1).toVar();
        const light = vec3(0).toVar();
        const tWeighted = float(0).toVar();
        const wSum = float(0).toVar();
        Loop({ start: int(0), end: int(steps), type: 'int', condition: '<', name: 'ci' }, ({ ci }: N) => {
          const f = float(ci).div(steps), n = float(ci).add(1).div(steps);
          const begin=distanceAt(f),end=distanceAt(n);
          const dt=end.sub(begin);
          const t=t0.add(begin).add(dt.mul(jitter));
          const alt = oy.add(dir.y.mul(t)).add(curve.mul(t).mul(t));
          const q = vec3(origin.x.add(dir.x.mul(t)), alt, origin.z.add(dir.z.mul(t))).toVar();
          const d = densityAt(q, true).toVar();
          If(d.greaterThan(0.002), () => {
            // Integrate to the sunward shell boundary, limited by the formation's
            // horizontal size. Cloud crowns have a short light path even at Low sun.
            const reach = min(u.top.sub(alt).div(max(sun.y, 0.09)), float(1500).div(u.frequency));
            If(inDeck.not().or(t.sub(lastLit).greaterThan(50)).or(d.sub(lastDensity).abs().greaterThan(0.16)), () => {
              // The first shadow midpoint can lie outside a close cloud wall.
              // Integrate the measured local condensate over a short segment,
              // then distribute the same sunward taps over the remaining path.
              const firstCell = reach.div(float(lightSteps).pow2());
              const localSpan = inDeck.select(min(firstCell.mul(0.25), float(25).div(u.frequency)), 0);
              const remaining = reach.sub(localSpan);
              const tau = d.mul(localSpan).toVar();
              Loop({ start: int(0), end: int(lightSteps), type: 'int', condition: '<', name: 'si' }, ({ si }: N) => {
                const a = float(si).div(lightSteps).pow2().mul(remaining);
                const b = float(si).add(1).div(lightSteps).pow2().mul(remaining);
                const midpoint = localSpan.add(a.add(b).mul(0.5));
                tau.addAssign(densityAt(q.add(sun.mul(midpoint)), false).mul(b.sub(a)));
              });
              shadowDepth.assign(tau.mul(EXTINCTION));
              If(u.skylightReach.greaterThan(0), () => {
                // A recessed lobe can see the solar beam yet have little open sky.
                // Estimate the short upward sky path independently of sun azimuth.
                const path = min(u.skylightReach, u.top.sub(alt)).max(0);
                const above = densityAt(q.add(vec3(0,path.mul(0.58),0)), false, false);
                const skyDepth = mix(d,above,0.72).mul(path).mul(EXTINCTION);
                skyAccess.assign(exp(skyDepth.mul(-0.85)).mul(0.60).add(0.40));
              });
              lastLit.assign(t); lastDensity.assign(d);
            });
            const od = shadowDepth;
            // Multiple-scattering octaves (each with a shallower extinction) instead of a flat
            // 72 % floor: sunward tops stay bright while deep bellies fall to a dim glow, so
            // banks read as sculpted volumes rather than uniform milk.
            const beer = exp(od.negate()).add(exp(od.mul(-0.42)).mul(0.3)).add(exp(od.mul(-0.15)).mul(0.1));
            // Powder darkening only when looking away from the sun (backlit edges stay bright).
            const powderRaw = float(1).sub(exp(d.mul(-2.6))).mul(0.55).add(0.45);
            const powder = mix(float(1), powderRaw, smoothstep(0.3, -0.5, mu));
            const h = alt.sub(u.base).div(u.top.sub(u.base)).clamp(0, 1);
            const localSun = sunlightAtHeight(alt).mul(incidentSun);
            // Forward scattering applies to the surviving direct beam. Successive scattering
            // widens the phase lobe, especially when the eye is inside a sun-facing bank.
            const directPhase = phase.mul(0.2).add(0.085);
            const softPhase = hg(mu, 0.35).mul(4 * Math.PI * 0.2).add(0.085);
            const first = exp(od.negate());
            const innerLight = first.mul(directPhase).add(beer.sub(first).mul(softPhase));
            const sunLight = localSun.mul(powder).mul(inDeck.select(innerLight, beer.mul(directPhase)));
            // Warm silver lining: thin, sun-facing-away edges forward-scatter strongly.
            const thin = exp(od.mul(-0.6)).mul(smoothstep(0.6, 0.05, d));
            const silver = localSun.mul(ice?vec3(1.01,1,1.02):vec3(1.08, 0.97, 0.84)).mul(hg(mu, 0.9).mul(4 * Math.PI * 0.05)).mul(thin);
            // Bases are lit by horizon sky + sea bounce, tops by the open zenith; sky light
            // is occluded deep inside the cell (sunward depth as proxy, no extra taps).
            const ambient = mix(frame.skyHorizon.mul(1.05), frame.skyZenith.mul(1.5), h)
              .mul(mix(0.5, 1.0, pow(h, 0.6))).mul(mix(0.55, 1.0, exp(od.mul(-0.25))))
              .mul(mix(1.0, 0.3, u.storm.mul(float(1).sub(h)))).mul(skyAccess);
            const flashDist = length(q.sub(u.flashPosition));
            const flash = u.flashColor.mul(exp(flashDist.div(-1900))).mul(float(1).div(flashDist.div(900).pow(2).add(1)));
            const radiance = sunLight.add(silver).add(ambient).add(flash);
            const stepTau = d.mul(EXTINCTION).mul(dt);
            const stepT = exp(stepTau.negate());
            const contrib = transmittance.mul(float(1).sub(stepT));
            light.addAssign(radiance.mul(contrib));
            tWeighted.addAssign(t.mul(contrib));
            wSum.addAssign(contrib);
            transmittance.mulAssign(stepT);
            If(transmittance.lessThan(0.015), () => { transmittance.assign(0); Break(); });
          });
        });
        // Aerial perspective: distant cloud dissolves into the scattering colour behind it.
        const meanT = tWeighted.div(max(wSum, 1e-4));
        if (distanceOut) distanceOut.assign(wSum.greaterThan(0.001).select(meanT, float(40000)));
        const clarity = exp(meanT.div(u.visibility).negate());
        const alpha = float(1).sub(transmittance);
        result.assign(vec4(mix(atmosphereColor.mul(alpha), light.add(cloudFireBounce(origin, dir, u.base).mul(alpha)), clarity), transmittance));
      }
    });
    return result;
  })();

  const shadow = (worldPosition: N): N => Fn(() => {
    const sun = frame.sunDirection;
    const sy = max(sun.y, 0.06);
    const thickness = u.top.sub(u.base);
    const tau = float(0).toVar();
    // Three taps through the lower half of the deck where most of the water sits.
    for (const f of SHADOW_HEIGHTS) {
      const alt = u.base.add(thickness.mul(f));
      const t = alt.sub(worldPosition.y).div(sy);
      const q = vec3(worldPosition.x.add(sun.x.mul(t)), alt, worldPosition.z.add(sun.z.mul(t)));
      tau.addAssign(densityAt(q, false));
    }
    const od = tau.div(SHADOW_HEIGHTS.length).mul(thickness).div(sy).mul(SHADOW_EXTINCTION);
    return max(exp(od.negate()), 0.07);
  })();

  const out=new Float64Array(4), turret=new Float64Array(4);
  const clamp=(x:number)=>Math.max(0,Math.min(1,x));
  const smooth=(a:number,b:number,x:number)=>{const f=clamp((x-a)/(b-a));return f*f*(3-2*f);};
  const remapCPU=(x:number,a:number,b:number)=>clamp((x-a)/Math.max(b-a,0.0001));
  const sampleDensity=(position:THREE.Vector3,time:number,detailed=true)=>{
    const h=(position.y-u.base.value)/(u.top.value-u.base.value);
    if(h<=0||h>=1||u.coverage.value<=0||u.density.value<=0)return 0;
    const sourceX=position.x-u.crownOffset.value.x*h*h, sourceZ=position.z-u.crownOffset.value.y*h*h;
    const x=(sourceX+u.offset.value.x)*u.frequency.value,y=position.y,z=(sourceZ+u.offset.value.z)*u.frequency.value;
    const img=weatherTex.image as {data:Uint8Array;width:number;height:number};
    sampleVolume(img.data,img.width,img.height,1,x*WEATHER_SCALE,z*WEATHER_SCALE,0,out);
    const coverage=u.coverage.value,storm=u.storm.value;
    const map=clamp(out[0]+(out[2]-0.5)*0.18);
    const cov=THREE.MathUtils.lerp(smooth(0.74-coverage,1.2-coverage,map)*0.88,1,smooth(0.72,1,coverage))*(distribution?.coverageAt(sourceX,sourceZ,time,upper)??1);
    const phase=distribution?.life?.at(sourceX,sourceZ,time,upper);
    const fray=phase===undefined ? 0 : (1-Math.cos(phase))*0.5;
    const development = clamp(Math.max(storm, smooth(0.26, 0.76, out[1]*0.62 + out[2]*0.38)) + u.convection.value +
      (phase===undefined?0:Math.sin(phase)*(upper?0.11:0.27)));
    const base=baseTex.image as {data:Uint8Array;width:number;height:number;depth:number};
    sampleVolume(base.data,base.width,base.height,base.depth,x*BASE_SCALE,y*BASE_SCALE,z*BASE_SCALE,out);
    const fbm = out[1]*0.625 + out[2]*0.25 + out[3]*0.125;
    let plume=0,lobe=0;
    if(u.billows.value>0){
      sampleVolume(img.data,img.width,img.height,1,x/4700+0.23,z/4700-0.41,0,turret);
      plume=smooth(0.24,0.65,turret[0]*0.72+turret[1]*0.28);
      const details=detailTex.image as {data:Uint8Array;width:number;height:number;depth:number};
      sampleVolume(details.data,details.width,details.height,details.depth,
        (x+z*0.31+(out[1]-0.45)*190)/980,(y*0.82+(out[2]-0.45)*190)/980,
        (z-x*0.31+(out[3]-0.45)*190)/980,turret);
      lobe=smooth(0.16,0.76,turret[0]*0.58+turret[1]*0.28+turret[2]*0.14)-0.48;
    }
    const crown = smooth(0.18, 0.72, fbm), floor = (1 - crown)*(phase===undefined?0.022:fray*0.045+0.012);
    const top = THREE.MathUtils.lerp((0.30 + 0.70*development)*(0.76 + 0.24*crown),
      THREE.MathUtils.clamp(0.24+0.76*plume+lobe*0.16,0.18,1),u.billows.value);
    const hn = (h - floor)/(top - floor);
    const covH = cov*THREE.MathUtils.lerp(1, 0.22+0.33*development, smooth(0.12, 0.96, hn))+storm*0.35*smooth(0.72,0.95,h)*cov;
    const rounded=(lobe*0.44+(plume-0.44)*0.23)*smooth(0.015,0.34,h)*u.billows.value;
    const shape = (remapCPU(out[0], (1-fbm)*0.42, 1)+rounded)*smooth(0,0.06,h-floor)*smooth(1,0.7,hn);
    let d = remapCPU(shape,1-covH,1-0.45*covH);
    if (d > 0.001 && d < 0.96) {
      let modifier = 0.20;
      if (detailed) {
        const dx = 0.8*x - 0.6*z + (out[1]-0.45)*290;
        const dy = -0.36*x + 0.8*y - 0.48*z + (out[2]-0.45)*290;
        const dz = 0.48*x + 0.6*y + 0.64*z + (out[3]-0.45)*290;
        const detail=detailTex.image as {data:Uint8Array;width:number;height:number;depth:number};
        sampleVolume(detail.data, detail.width, detail.height, detail.depth, dx*DETAIL_SCALE, dy*DETAIL_SCALE+time*0.006, dz*DETAIL_SCALE,out);
        const cells = smooth(0.21,0.69,out[0]*0.48+out[1]*0.34+out[2]*0.18);
        modifier = THREE.MathUtils.lerp(cells,1-cells,clamp(h*4))*0.86+0.08;
      }
      const eroded = remapCPU(d, modifier*u.erosion.value*(phase===undefined?1:fray*0.94+0.79), 1);
      d = THREE.MathUtils.lerp(d,eroded,1-smooth(0.65,0.96,d));
    }
    return d*u.density.value*(1+1.4*storm);
  };
  const tap = new THREE.Vector3();
  const sunTransmissionAt = (receiver: THREE.Vector3, sun: THREE.Vector3, time: number) => {
    const start = Math.max(receiver.y, u.base.value), thickness = u.top.value - start;
    if (thickness <= 0 || u.coverage.value <= 0 || u.density.value <= 0) return 1;
    const sy = Math.max(sun.y, 0.06);
    let density = 0;
    for (const fraction of SHADOW_HEIGHTS) {
      const height = start + thickness * fraction, distance = (height - receiver.y) / sy;
      tap.set(receiver.x + sun.x * distance, height, receiver.z + sun.z * distance);
      density += sampleDensity(tap, time, false);
    }
    return Math.max(0.07, Math.exp(-density * thickness * SHADOW_EXTINCTION / (SHADOW_HEIGHTS.length * sy)));
  };
  return { uniforms: u, march, shadow, sampleDensity, sunTransmissionAt, densityNode: (p,disturbed=true)=>densityAt(p,true,disturbed) };
}
