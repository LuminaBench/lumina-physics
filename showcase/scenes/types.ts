import type { LuminaEngine } from '../../engine/engine';
import type { Panel } from '../ui';

export interface SceneContext {
  engine: LuminaEngine;
  panel: Panel;
  canvas: HTMLCanvasElement;
}

export interface SceneHandle {
  /** Extra HUD lines (already HTML-safe). */
  hud?(): string[];
  /** Anything the scene wants QA / the console to reach. */
  debug?: Record<string, unknown>;
  dispose(): void;
}

export interface ShowcaseScene {
  id: string;
  label: string;
  title: string;
  description: string;
  create(context: SceneContext): Promise<SceneHandle>;
}
