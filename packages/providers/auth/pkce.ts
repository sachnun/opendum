import { Effect } from "effect";

export class Pkce {
  static verifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Pkce.encode(bytes);
  }

  static encode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static challenge(verifier: string, label: string) {
    return Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      catch: (cause) => new Error(`Failed to build ${label} code challenge`, { cause }),
    }).pipe(Effect.map((digest) => Pkce.encode(new Uint8Array(digest))));
  }

  static pair(label: string) {
    const verifier = Pkce.verifier();
    return Pkce.challenge(verifier, label).pipe(Effect.map((challenge) => ({ verifier, challenge })));
  }
}
