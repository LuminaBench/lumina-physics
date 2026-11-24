import type { N } from '../../engine/tsl';
import { retainedTreadFilm, TreadTransfer, type TreadContact } from '../wet-road/tread-transfer';
import { Coastline, type CoastOptions } from './coastline';
import { CoastalSurf, type SurfOptions } from './surf';
import { CoastalSediment, type SedimentSave } from './sediment';

export interface DeckContact {
  /** Stable host surface name. Separate decks at the same XZ keep separate contact maps. */
  id: string;
  water: number;
  film: number;
  soil: number;
}
export interface CoastalHostOptions {
  coast: CoastOptions;
  surf: SurfOptions;
  heightAt: (x: number, z: number) => number;
  /** Decide whether the contact at this height belongs to an existing road, bridge or platform. */
  deckAt?: (x: number, y: number, z: number) => DeckContact | undefined;
  rainAt?: (x: number, z: number) => number;
  waterColumn?: import('./sand-water').SandWaterOptions;
  save?: SedimentSave;
  maxTiles?: number;
  retainAt?: (x: number, z: number) => boolean;
}
export class CoastalAttachment {
  readonly coast: Coastline;
  readonly surf: CoastalSurf;
  readonly sediment: CoastalSediment;
  private readonly maps = new Map<string, TreadTransfer>();
  constructor(readonly host: CoastalHostOptions) {
    this.coast = new Coastline({ ...host.coast, heightAt: host.heightAt });
    this.surf = new CoastalSurf(this.coast, host.surf, host.heightAt);
    this.sediment = new CoastalSediment(this.coast, this.surf, {
      ground: host.heightAt,
      waterColumn: host.waterColumn,
      barrierAt: host.surf.barrierAt,
      rainAt: host.rainAt,
      maxTiles: host.maxTiles,
      retainAt: host.retainAt,
    });
    if (host.save) this.sediment.restore(host.save);
  }
  /** Register the fixed layers the game actually draws. Sampling an unknown layer never creates a texture. */
  layer(id: string) {
    let map = this.maps.get(id);
    if (map) return map;
    if (!id || this.maps.size >= 8)
      throw new RangeError('Register one to eight named coastal contact surfaces');
    map = new TreadTransfer();
    this.maps.set(id, map);
    return map;
  }
  trackNode(id: string, worldXZ: N) {
    return this.layer(id).sampleNode(worldXZ);
  }
  wheel(width = 0.24, radius = 0.32, grooves = 0.006) {
    const attachment = this,
      ground = this.layer('ground').contact(width),
      contacts = new Map<string, TreadContact>([['ground', ground]]);
    let previous: TreadContact | undefined,
      film = 0,
      soil = 0,
      oldX = Infinity,
      oldZ = Infinity;
    return {
      sample(
        x: number,
        y: number,
        z: number,
        dt: number,
        speed: number,
        load: number,
        yaw: number,
        slip = 0,
      ) {
        const deck = attachment.host.deckAt?.(x, y, z),
          s = attachment.sediment.inspect(x, z);
        const layer = deck?.id ?? 'ground',
          depth = deck?.water ?? s.water,
          wetness = deck?.film ?? s.film,
          loose = deck?.soil ?? (0.26 + 0.48 * s.film) * (1 - s.packing * 0.7);
        let contact = contacts.get(layer);
        if (!contact) {
          contact = attachment.layer(layer).contact(width);
          contacts.set(layer, contact);
        }
        if (previous !== contact) {
          previous?.reset();
          contact.reset();
          contact.soil = soil;
        }
        film = retainedTreadFilm(
          film,
          load > 0 ? depth : 0,
          load > 0 ? wetness : 0,
          grooves,
          radius,
          speed,
          dt,
        );
        contact.sample(x, z, film, depth, wetness, loose, load, Math.max(0.5, dt * Math.abs(speed) * 2));
        soil = contact.soil;
        previous = contact;
        if (!deck && load > 0.05 && Math.hypot(x - oldX, z - oldZ) > 0.14) {
          attachment.sediment.imprint('wheel', x, z, yaw, width, 0.28, load, slip);
          oldX = x;
          oldZ = z;
        } else if (deck || load <= 0.05) {
          oldX = Infinity;
          oldZ = Infinity;
        }
        return film;
      },
      get film() {
        return film;
      },
      get soil() {
        return soil;
      },
      reset() {
        for (const c of contacts.values()) c.reset();
        film = soil = 0;
        previous = undefined;
        oldX = oldZ = Infinity;
      },
    };
  }
  update(dt: number, x: number, z: number, seaLevel: number, waveHeight: number) {
    this.sediment.update(dt, x, z, seaLevel, waveHeight);
    for (const map of this.maps.values()) map.update(dt, x, z);
  }
  dispose() {
    this.surf.dispose();
    for (const m of this.maps.values()) m.dispose();
    this.maps.clear();
  }
}
