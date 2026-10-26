# Model refresh pipeline

Registry model di `packages/models/data` dan `packages/models/generated` diperbarui oleh pipeline ini.

## Struktur

| Folder | Isi |
|---|---|
| `run.ts` | Entry point `bun run refresh`. Orkestrasi + PR summary. |
| `core/` | Infrastruktur bersama: kontrak, key-mapping, runner, env, fetch. |
| `providers/` | Satu extension per provider. Hanya di sini kode spesifik provider. |
| `steps/` | Step global lintas-provider yang jalan setelah semua provider. |

## Menambah provider

1. Buat `providers/<key>.ts` yang mengekspor `ModelSource`.
2. Daftarkan di `providers/index.ts`.

Tidak ada file lain yang perlu disentuh.

## Menonaktifkan provider

Hapus dari array `SOURCES` di `providers/index.ts`. Model yang sudah ada tidak dihapus; provider hanya berhenti diperbarui.

## Kontrak `ModelSource`

| Field | Wajib | Keterangan |
|---|---|---|
| `provider` | ya | Key provider, harus sama dengan `providers` di registry. |
| `label` | ya | Nama tampil untuk log. |
| `order` | ya | Urutan eksekusi dalam fase. |
| `phase` | ya | `fetch` untuk provider, `tail` untuk step global. |
| `fetch` | ya | Mengembalikan `SourceResult`. |
| `enrich` | tidak | Menyentuh metadata setelah `sync` (reasoning, modalities, aliases). |
| `versionTargets` | tidak | File yang versinya di-sync dari upstream. |
| `latestVersion` | tidak | Sumber versi terbaru untuk `versionTargets`. |

## Perintah

```bash
bun run --filter @opendum/models refresh --dry-run
bun run --filter @opendum/models refresh
bun run --filter @opendum/models family-ranking
```
