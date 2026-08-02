import { randomBytes } from "node:crypto";

const cuidAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Mirrors apps/proxy/internal/db/id.go NewID(): "c" + 23 cuid-alphabet chars. */
export function newID(): string {
  const buf = randomBytes(18);
  const out = new Array<string>(24);
  out[0] = "c";
  for (let i = 1; i < out.length; i++) {
    out[i] = cuidAlphabet[buf[(i - 1) % buf.length] % cuidAlphabet.length];
  }
  return out.join("");
}
