/** Simulation notifications, in world space and simulation time. Listeners own their subscriptions. */
export type PhysicsEventName =
  | 'explosion' | 'sonicBoom' | 'lightning' | 'splash' | 'shatter' | 'steam'
  | 'waveBreak' | 'aquaplane' | 'flyby' | 'downwash' | 'flutter' | 'ropeTension'
  | 'groundDisplaced' | 'canopyOpen' | 'impact';

export interface PhysicsEventPayload {
  position?: readonly [number, number, number];
  intensity: number;
  kind?: string;
  params?: Readonly<Record<string, number>>;
}

type Listener = (event: PhysicsEventPayload) => void;

export class PhysicsEvents {
  private readonly channels = new Map<PhysicsEventName, Set<Listener>>();

  on(name: PhysicsEventName, listener: Listener): () => void {
    let channel = this.channels.get(name);
    if (!channel) this.channels.set(name, channel = new Set());
    channel.add(listener);
    return () => channel.delete(listener);
  }

  hasListeners(name: PhysicsEventName): boolean { return (this.channels.get(name)?.size ?? 0) > 0; }

  /** Build the owned event position only when a receiver is listening. */
  emitAt(name: PhysicsEventName, position: { x: number; y: number; z: number }, intensity: number, kind?: string): void {
    if (!this.hasListeners(name)) return;
    const payload: PhysicsEventPayload = { position: [position.x, position.y, position.z], intensity };
    if (kind !== undefined) payload.kind = kind;
    this.emit(name, payload);
  }

  emit(name: PhysicsEventName, payload: PhysicsEventPayload): void {
    const channel = this.channels.get(name);
    if (channel) for (const listener of channel) listener(payload);
  }

  clear(): void { this.channels.clear(); }
}
