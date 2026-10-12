/**
 * Event bus bertipe.
 *
 * `CaptureSession` memberi tahu dunia lewat bus ini, bukan lewat callback
 * bertumpuk. Yang penting: **tidak ada `EventTarget`** — `EventTarget` tidak
 * bertipe, dan `CustomEvent` memaksa pemakaian `any`. Bus kecil ini generik
 * penuh, jadi nama event dan bentuk payload-nya diperiksa compiler.
 *
 * Batasnya `object`, bukan `Record<string, unknown>`: `interface` tidak punya
 * index signature, jadi `Record<string, unknown>` menolak semua peta event
 * yang ditulis sebagai `interface` — dan itu cara yang wajar menulisnya.
 */

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }

    set.add(listener as Listener<never>);

    return () => {
      this.off(event, listener);
    };
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;

    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;

    // Salin dulu: listener boleh berhenti berlangganan saat event diproses,
    // dan memutasi Set saat di-iterasi itu bug klasik.
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
