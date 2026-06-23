/**
 * Tiny, typed publish/subscribe event bus.
 *
 * This is a GENERIC, gameplay-agnostic primitive (Core layer): it knows
 * nothing about fishing, penguins or scores. A game defines its own
 * event map and instantiates a typed bus from it, e.g.:
 *
 * ```ts
 * interface MyEvents { fishCaught: { score: number } }
 * const bus = new EventBus<MyEvents>()
 * const off = bus.on('fishCaught', (e) => console.log(e.score))
 * bus.emit('fishCaught', { score: 10 })
 * off() // unsubscribe
 * ```
 *
 * Why: it lets systems react to gameplay "facts" without the emitter
 * having to know who's listening — so new mechanics (achievements,
 * combos, stats…) subscribe to an existing event instead of editing the
 * place that produced it. Keeps orchestration (e.g. "what happens when a
 * fish is caught") from piling up in one method.
 */
export type EventHandler<T> = (payload: T) => void

export class EventBus<Events extends Record<string, unknown>> {
  private readonly handlers: { [K in keyof Events]?: Set<EventHandler<Events[K]>> } = {}

  /**
   * Subscribe to an event. Returns an unsubscribe function — call it (or
   * `off`) to detach. Safe to subscribe/unsubscribe during dispatch.
   */
  on<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): () => void {
    let set = this.handlers[type]
    if (!set) {
      set = new Set<EventHandler<Events[K]>>()
      this.handlers[type] = set
    }
    set.add(handler)
    return () => this.off(type, handler)
  }

  off<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): void {
    this.handlers[type]?.delete(handler)
  }

  /**
   * Fire an event synchronously to every current subscriber. Handlers run
   * in subscription order over a SNAPSHOT, so a handler may add/remove
   * subscribers without disturbing the in-flight dispatch. A throwing
   * handler is logged and isolated so it can't break the others.
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers[type]
    if (!set || set.size === 0) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[EventBus] handler for "${String(type)}" threw:`, err)
      }
    }
  }

  /** Drop every subscriber (used on teardown). */
  clear(): void {
    for (const key of Object.keys(this.handlers) as (keyof Events)[]) {
      this.handlers[key]?.clear()
    }
  }
}
