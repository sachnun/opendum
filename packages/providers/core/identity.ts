import { Buffer } from "node:buffer";

import { Value } from "./values.js";

export type Claims = Record<string, unknown>;

export class ModelName {
  static segment(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1] ?? "";
  }
}

export class Jwt {
  static claims(token: string): Claims | null {
    const parts = token.split(".");
    const payload = parts[1];
    if (parts.length < 2 || !payload) return null;
    try {
      return Value.record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    } catch {
      return null;
    }
  }

  static claim(claims: Claims, key: string): string {
    return Value.trimmed(claims[key]);
  }

  static nested(claims: Claims, key: string): Claims | null {
    return Value.record(claims[key]);
  }

  static first(claims: Claims, keys: string[]): string {
    for (const key of keys) {
      const value = Jwt.claim(claims, key);
      if (value) return value;
    }
    return "";
  }
}
