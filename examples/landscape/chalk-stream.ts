import { terrainReading } from '../../modules/terrain/surface';
import { bellFlower } from '../../modules/landscape/flowers';
import { TSL } from '../../engine/tsl';
import { createLandLibrary, propRoots } from '../../modules/landscape/collection';
import type { LandscapeProfile } from '../../modules/landscape/authored';
import type { LandLibrary } from '../../modules/landscape/library';

// Keep these definitions in your game. A selective install exports the same symbols
// from its generated index.ts, so only the import paths change.
export function addSilverBirch(library: LandLibrary) {
  return library.define(
    'plant',
    'game:silver-birch',
    {
      height: 11.6,
      breadth: 2.1,
      crownBase: 0.43,
      lean: 0.14,
      limbs: 15,
      bark: '#dcd8c9',
      foliage: '#abc57e',
      leafWidth: 0.67,
      variants: 3,
      grow(form) {
        // Exposed outer sprays droop beyond the supporting twigs.
        for (const leaf of form.leaves) leaf.tip.y -= Math.hypot(leaf.tip.x, leaf.tip.z) * 0.17;
        return form;
      },
    },
    'lumina:birch',
  );
}

export function addWoodBluebell(library: LandLibrary) {
  const probe = terrainReading();
  return library.define(
    'cover',
    'game:wood-bluebell',
    {
      flowerHead(head, writer) {
        for (let i = 0; i < 3; i++) {
          const t = i * 0.78;
          bellFlower(
            {
              ...head,
              x: head.x + Math.cos(head.phase) * t * head.radius,
              y: head.y - t * head.radius,
              z: head.z + Math.sin(head.phase) * t * head.radius,
              radius: head.radius * (1 - 0.09 * i),
            },
            writer,
          );
        }
      },
      height: 0.29,
      petals: 6,
      radius: 0.026,
      bell: -1.6,
      spacing: 8,
      bloom: ['spring', 'autumn'],
      petalColor: '#6879cb',
      stemColor: '#699451',
      minimumShade: 0.46,
      canFlower(site, terrain) {
        const rim =
          (terrain.sample(site.x - 5, site.z, probe).height +
            terrain.sample(site.x + 5, site.z, probe).height +
            terrain.sample(site.x, site.z - 5, probe).height +
            terrain.sample(site.x, site.z + 5, probe).height) *
          0.25;
        return rim - site.height > 0.03;
      },
      patchSize: 13,
    },
    'lumina:bluebells',
  );
}

export function addPropRootTree(library: LandLibrary) {
  return library.define(
    'plant',
    'game:tide-roots',
    {
      grow(form, seed) {
        const first = form.wood.length;
        propRoots(form, seed);
        for (const root of form.wood.slice(first)) {
          root.base *= 1.35;
          for (const point of root.path) {
            point.x *= 1.45;
            point.z *= 1.45;
          }
        }
        return form;
      },
    },
    'lumina:mangrove',
  );
}

export function addChalkStream(library: LandLibrary) {
  return library.define(
    'region',
    'game:chalk-stream',
    {
      rock: 'lumina:chalk',
      cover: 'game:wood-bluebell',
      plants: [
        { plant: 'game:silver-birch', weight: 3 },
        { plant: 'lumina:willow', weight: 3, minMoisture: 0.44 },
        { plant: 'lumina:oak', weight: 2 },
        { plant: 'lumina:fern', weight: 2 },
      ],
      shape(x, z, h) {
        return h + Math.max(0, Math.min(1, (h - 2) / 7)) * Math.sin(z * 0.039 + x * 0.022) * 1.8;
      },
      place(site, id) {
        return id === 'game:silver-birch'
          ? 0.2 + site.exposure * 2
          : id === 'lumina:fern'
            ? site.shade * 2
            : 1;
      },
    },
    'lumina:seasonal-woodland',
  );
}

export function addGouache(library: LandLibrary) {
  return library.define(
    'direction',
    'game:ochre-gouache',
    {
      ground: '#b7946a',
      foliage: '#9aa35b',
      transmission: 0.23,
      leafShader(color) {
        const stroke = TSL.positionWorld.x.mul(0.87).add(TSL.positionWorld.y.mul(1.31)).sin();
        return TSL.mix(
          color,
          TSL.floor(color.mul(12).add(stroke.mul(0.16)))
            .max(0)
            .div(12),
          0.68,
        );
      },
    },
    'lumina:painted',
  );
}

export function chalkStreamGarden() {
  const library = createLandLibrary();
  addSilverBirch(library);
  addWoodBluebell(library);
  addPropRootTree(library);
  addChalkStream(library);
  addGouache(library);
  const landscape: LandscapeProfile = {
    revision: 1,
    region: 'game:chalk-stream',
    direction: 'game:ochre-gouache',
    season: 'spring',
  };
  return { library, landscape };
}
