/** Minimal dependency-free control surface for the showcase. */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * Pointer / wheel events that start on a control must never reach the canvas camera
 * controls or any global handler: stop them at the control's root.
 */
function isolate(node: HTMLElement): void {
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchend', 'contextmenu']) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }
}

export class Panel {
  readonly root = el('div', 'panel');

  constructor() { isolate(this.root); }
  private refreshers: Array<() => void> = [];

  clear(): void { this.root.replaceChildren(); this.refreshers = []; }

  header(title: string, description: string): void {
    this.root.append(el('h2', '', title), el('p', '', description));
  }

  section(title: string): void { this.root.append(el('h3', '', title)); }

  slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, format: (v: number) => string = (v) => v.toFixed(2)): HTMLInputElement {
    const row = el('div', 'row');
    const input = el('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    const out = el('output');
    const refresh = () => { input.value = String(get()); out.textContent = format(get()); };
    input.addEventListener('input', () => { set(Number(input.value)); out.textContent = format(Number(input.value)); });
    row.append(el('label', '', label), input, out);
    this.root.append(row);
    this.refreshers.push(refresh);
    refresh();
    return input;
  }

  select<T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void): void {
    const row = el('div', 'row');
    const input = el('select');
    for (const [value, text] of options) { const o = el('option', '', text); o.value = value; input.append(o); }
    input.value = get();
    input.addEventListener('change', () => set(input.value as T));
    row.append(el('label', '', label), input);
    this.root.append(row);
  }

  /** A row of buttons. `toggle` buttons keep an on/off outline driven by `isOn`. */
  buttons(items: Array<{ label: string; onClick: () => void; primary?: boolean; isOn?: () => boolean }>): void {
    const row = el('div', 'buttons');
    for (const item of items) {
      const b = el('button', item.primary ? 'primary' : '', item.label);
      const refresh = () => { if (item.isOn) b.classList.toggle('on', item.isOn()); };
      // Blur after the click so keyboard shortcuts (1–6, [ ], driving keys) keep working.
      b.addEventListener('click', () => { item.onClick(); for (const r of this.refreshers) r(); b.blur(); });
      this.refreshers.push(refresh);
      refresh();
      row.append(b);
    }
    this.root.append(row);
  }

  note(text: string): void { this.root.append(el('p', '', text)); }

  /** Re-read every control from its getter (after programmatic changes). */
  refresh(): void { for (const r of this.refreshers) r(); }
}

export interface Chrome {
  panel: Panel;
  setHud(html: string): void;
  setScene(id: string): void;
  setTier(id: string): void;
  setLoading(text: string | null): void;
  showError(message: string): void;
}

export function buildChrome(options: {
  scenes: Array<{ id: string; label: string }>;
  tiers: Array<{ id: string; label: string }>;
  onScene: (id: string) => void;
  onTier: (id: string) => void;
}): Chrome {
  const ui = document.getElementById('ui')!;
  ui.replaceChildren();
  const bar = el('div', 'bar');
  const brand = el('div', 'brand', 'lumina-physics');
  const sceneGroup = el('div', 'group');
  const sceneButtons = new Map<string, HTMLButtonElement>();
  options.scenes.forEach((scene, i) => {
    const b = el('button', '', `${i + 1} · ${scene.label}`);
    b.dataset.scene = scene.id;
    b.addEventListener('click', () => { options.onScene(scene.id); b.blur(); });
    sceneButtons.set(scene.id, b);
    sceneGroup.append(b);
  });
  const tierGroup = el('div', 'group');
  const tierButtons = new Map<string, HTMLButtonElement>();
  for (const tier of options.tiers) {
    const b = el('button', '', tier.label);
    b.dataset.tier = tier.id;
    b.addEventListener('click', () => { options.onTier(tier.id); b.blur(); });
    tierButtons.set(tier.id, b);
    tierGroup.append(b);
  }
  for (const group of [sceneGroup, tierGroup]) isolate(group);
  bar.append(brand, sceneGroup, el('div', 'spacer'), tierGroup);
  const hud = el('div', 'hud');
  const panel = new Panel();
  const loading = el('div', 'loading hidden', 'Loading…');
  ui.append(bar, hud, panel.root, loading);
  return {
    panel,
    setHud(html) { hud.innerHTML = html; },
    setScene(id) { for (const [key, b] of sceneButtons) b.classList.toggle('active', key === id); },
    setTier(id) { for (const [key, b] of tierButtons) b.classList.toggle('active', key === id); },
    setLoading(text) { if (text !== null) loading.textContent = text; loading.classList.toggle('hidden', text === null); },
    showError(message) { ui.append(el('div', 'error', message)); },
  };
}
