export const BIOMES = ['coastal-cliffs', 'temperate-river-valley', 'dry-highlands'] as const;
export type Biome = (typeof BIOMES)[number];
