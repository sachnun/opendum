export class Value {
  static string(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  static trimmed(value: unknown): string {
    return Value.string(value).trim();
  }

  static record(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  static stringOr(value: unknown, fallback: string): string {
    const str = Value.string(value);
    return str !== "" ? str : fallback;
  }

  static nonEmpty(value: string, fallback: string): string {
    return value !== "" ? value : fallback;
  }

  static number(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
    return 0;
  }

  static bool(value: unknown): boolean {
    return value === true;
  }

  static strings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const str = Value.string(item);
      if (str !== "") out.push(str);
    }
    return out;
  }

  static unique(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }
}

export class Payload {
  static clone(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        out[key] = Payload.clone(value as Record<string, unknown>);
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  static filter(
    input: Record<string, unknown>,
    supported: Set<string>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (supported.has(key) && value !== undefined && value !== null) out[key] = value;
    }
    return out;
  }

  static toolChoice(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const choice = value as Record<string, unknown>;
    if (choice.type !== "function") return value;
    const fn = (choice.function ?? {}) as Record<string, unknown>;
    const name = Value.string(fn.name) || Value.string(choice.name);
    if (!name) return value;
    return { type: "function", name };
  }

  static text(content: unknown): string {
    if (typeof content === "string") return content;
    if (content !== null && typeof content === "object" && !Array.isArray(content)) {
      const item = content as Record<string, unknown>;
      for (const key of ["text", "input_text", "output_text"]) {
        const value = Value.string(item[key]);
        if (value) return value;
      }
      if (item.content !== undefined) return Payload.text(item.content);
    }
    if (Array.isArray(content)) {
      const chunks: string[] = [];
      for (const raw of content) {
        const part = raw as Record<string, unknown>;
        for (const key of ["text", "input_text", "output_text"]) {
          const value = Value.string(part[key]);
          if (value) {
            chunks.push(value);
            break;
          }
        }
        if (part.type === "tool_result" && part.content !== undefined) {
          chunks.push(Payload.text(part.content));
        }
      }
      return chunks.join("");
    }
    return "";
  }

  static instructions(messages: unknown[]): string {
    const parts: string[] = [];
    for (const raw of messages) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      const role = Value.string(msg.role);
      if (role !== "system" && role !== "developer") continue;
      const text = Payload.text(msg.content).trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }
}

export class Ids {
  static random(prefix: string): string {
    return `${prefix}_${Ids.hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  }

  static uuid(): string {
    return crypto.randomUUID();
  }

  static uuidV7(): string {
    return Bun.randomUUIDv7("hex").replaceAll("-", "");
  }

  static seeded(seed: string): string {
    const chars = new Bun.CryptoHasher("sha256").update(seed).digest("hex").slice(0, 32).split("");
    chars[12] = "7";
    chars[16] = "8";
    return chars.join("");
  }

  static hex(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
  }
}

export class Responses {
  static json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  static sse(body: ReadableStream<Uint8Array>): Response {
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
