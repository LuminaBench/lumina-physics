import { createLandLibrary, generateRegionMap, type WorldProfile } from '../physics';
import { treeId, registerTree } from './cindercomb';
import { flowerId, meadowId, registerFlowers, revisedId } from './flowers';
import { directionId, registerPaint } from './paint';
import { chalkBanks, plantable, seeds, substrate } from './valley';
export const regionId = 'reach:chalk-stream';
export function project(revised: boolean) {
  const library = createLandLibrary();
  registerTree(library);
  registerFlowers(library);
  registerPaint(library);
  library.define(
    'region',
    regionId,
    {
      rock: 'lumina:chalk',
      cover: meadowId,
      direction: directionId,
      shape: chalkBanks,
      latitude: 51.1,
      plants: [
        { plant: treeId, weight: 6.5 },
        { plant: 'lumina:fern', weight: 1.4 },
      ],
      place(site, id) {
        return id === treeId ? 0.5 + site.exposure * 2 : site.shade * 1.4;
      },
    },
    'lumina:seasonal-woodland',
  );
  const bloomId = revised ? revisedId : flowerId;
  const profile: WorldProfile = {
    profileVersion: 1,
    seed: 721,
    weather: 'clear',
    time: 16.2,
    quality: 'medium',
    landscape: {
      revision: 1,
      region: regionId,
      season: 'autumn',
      direction: directionId,
      treeDensity: 0.86,
      meadowDensity: 0.52,
      latitude: 51.1,
      dayOfYear: 282,
      seeds,
      dependencies: ['cover/' + bloomId],
    },
  };
  return {
    profile,
    bloomId,
    recipe: library.get('cover', bloomId),
    runtime: {
      library,
      plantable,
      substrate,
      heightmap: generateRegionMap(library.get('region', regionId), seeds.terrain, 192, 144),
    },
  };
}
