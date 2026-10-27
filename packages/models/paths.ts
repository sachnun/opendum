export const sep = "/";

function isAbsolute(value: string): boolean {
  return value.startsWith("/");
}

function normalize(value: string): string {
  const absolute = isAbsolute(value);
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (absolute) return joined.length === 0 ? "/" : `/${joined}`;
  return joined.length === 0 ? "." : joined;
}

export function join(...parts: string[]): string {
  const meaningful = parts.filter((part) => part.length > 0);
  if (meaningful.length === 0) return ".";
  const joined = normalize(meaningful.join("/"));
  const wantsTrailing = meaningful[meaningful.length - 1]?.endsWith("/") ?? false;
  if (!wantsTrailing || joined === "/" || joined.endsWith("/")) return joined;
  return `${joined}/`;
}

export function dirname(value: string): string {
  if (value.length === 0) return ".";
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) return "/";
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return trimmed.startsWith("//") ? trimmed.slice(0, 2) : "/";
  if (index === 1 && trimmed.startsWith("//")) return "//";
  return trimmed.slice(0, index);
}

export function basename(value: string, suffix?: string): string {
  const trimmed = value.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  const base = index < 0 ? trimmed : trimmed.slice(index + 1);
  if (suffix && suffix.length > 0 && base.endsWith(suffix) && base !== suffix) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
}

export function extname(value: string): string {
  const base = basename(value);
  if (base === "..") return "";
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index);
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  for (let index = parts.length - 1; index >= -1; index -= 1) {
    const part = index >= 0 ? (parts[index] ?? "") : process.cwd();
    if (part.length === 0) continue;
    resolved = resolved.length === 0 ? part : `${part}/${resolved}`;
    if (isAbsolute(part)) break;
  }
  return normalize(resolved.length === 0 ? process.cwd() : resolved);
}

export function relative(from: string, to: string): string {
  const fromSegments = normalize(resolve(from)).split("/").filter(Boolean);
  const toSegments = normalize(resolve(to)).split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1;
  }
  const up = Array.from({ length: fromSegments.length - shared }, () => "..");
  const down = toSegments.slice(shared);
  const combined = [...up, ...down].join("/");
  return combined.length === 0 ? "" : combined;
}

export function fileUrl(url: string | URL): string {
  return Bun.fileURLToPath(url);
}

export function moduleDir(url: string | URL): string {
  return dirname(fileUrl(url));
}
