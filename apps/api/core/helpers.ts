import { Effect, Result } from "effect";

export class Safe {
  static sync<T>(fn: () => T, fallback: T): T {
    const result = Effect.runSync(Effect.result(Effect.try({ try: fn, catch: (cause) => cause })));
    return Result.isSuccess(result) ? result.success : fallback;
  }

  static async async<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const result = await Effect.runPromise(
      Effect.result(Effect.tryPromise({ try: fn, catch: (cause) => cause }))
    );
    return Result.isSuccess(result) ? result.success : fallback;
  }

  static result<T>(fn: () => T): Result.Result<T, unknown> {
    return Effect.runSync(Effect.result(Effect.try({ try: fn, catch: (cause) => cause })));
  }

  static json(text: string): Result.Result<unknown, unknown> {
    return Safe.result(() => JSON.parse(text) as unknown);
  }
}

export class Coerce {
  static string(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  static stringOr(value: unknown, fallback: string): string {
    const str = Coerce.string(value);
    return str !== "" ? str : fallback;
  }

  static int(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
    return 0;
  }

  static float(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  static bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }
}

export class Records {
  static clone(input: Record<string, unknown>): Record<string, unknown> {
    return { ...input };
  }

  static omit(
    input: Record<string, unknown>,
    ...excluded: string[]
  ): Record<string, unknown> {
    const exclude = new Set(excluded);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!exclude.has(key)) out[key] = value;
    }
    return out;
  }

  static list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  static maps(value: unknown): Record<string, unknown>[] {
    return Records.list(value).filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item)
    );
  }
}

export class Delay {
  static sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  }
}
