import { antigravitySource } from "@opendum/models/refresh/providers/antigravity";
import { clineSource } from "@opendum/models/refresh/providers/cline";
import { cloudflareSource } from "@opendum/models/refresh/providers/cloudflare";
import { codexSource } from "@opendum/models/refresh/providers/codex";
import { harborSource } from "@opendum/models/refresh/providers/harbor";
import { hyperSource } from "@opendum/models/refresh/providers/hyper";
import { kilocodeSource } from "@opendum/models/refresh/providers/kilo-code";
import { kiroSource } from "@opendum/models/refresh/providers/kiro";
import { nvidiaSource } from "@opendum/models/refresh/providers/nvidia";
import { opencodeSource } from "@opendum/models/refresh/providers/opencode";
import { openrouterSource } from "@opendum/models/refresh/providers/openrouter";
import { perchSource } from "@opendum/models/refresh/providers/perch";
import { workbuddySource } from "@opendum/models/refresh/providers/workbuddy";
import { zenmuxSource } from "@opendum/models/refresh/providers/zenmux";
import type { ModelSource } from "@opendum/models/refresh/core/types";

export const SOURCES: ReadonlyArray<ModelSource> = [
  antigravitySource,
  clineSource,
  cloudflareSource,
  codexSource,
  harborSource,
  hyperSource,
  kilocodeSource,
  kiroSource,
  nvidiaSource,
  opencodeSource,
  openrouterSource,
  perchSource,
  workbuddySource,
  zenmuxSource,
];
