# @opendum/crypto

Cryptographic primitives used for credential storage and internal requests.

## API

- `encrypt` / `decrypt` - symmetric encryption for stored provider credentials.
- `signature` helpers - internal request signing and constant-time comparison.
- `cryptojs` - CryptoJS-compatible payload decryption.

## Commands

| Command | Description |
| --- | --- |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
