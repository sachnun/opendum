import { Effect } from "effect";

type Entry<A> = {
  value: A;
  at: number;
};

export class TtlCache<A> {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, Entry<A>>();
  private readonly pending = new Map<string, Promise<A>>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): A | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: A): void {
    this.entries.set(key, { value, at: Date.now() });
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  load(key: string, run: () => Promise<A>): Effect.Effect<A, unknown> {
    const cached = this.get(key);
    if (cached !== undefined) return Effect.succeed(cached);

    const existing = this.pending.get(key);
    if (existing) return Effect.promise(() => existing);

    const task = run()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, task);
    return Effect.promise(() => task);
  }
}
