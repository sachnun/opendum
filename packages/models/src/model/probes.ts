import type { ModelData } from "#models/model/types.ts";

export interface ProbeSource {
  id: string;
  fileId: string;
  data: ModelData;
}

export interface ProbeSets {
  core: Set<string>;
  aliases: Set<string>;
}

function add(probes: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) probes.add(trimmed);
}

export function modelProbeSets(source: ProbeSource): ProbeSets {
  const core = new Set<string>();
  const aliases = new Set<string>();

  add(core, source.id);
  add(core, source.fileId);
  for (const config of Object.values(source.data.providerConfig ?? {})) {
    add(core, config?.upstream);
    const upstream = config?.upstream;
    if (typeof upstream === "string") add(core, upstream.split("/").pop());
  }
  for (const alias of source.data.aliases ?? []) {
    if (!core.has(alias)) add(aliases, alias);
  }

  return { core, aliases };
}

export function modelProbes(source: ProbeSource): Set<string> {
  const { core, aliases } = modelProbeSets(source);
  return new Set([...core, ...aliases]);
}
