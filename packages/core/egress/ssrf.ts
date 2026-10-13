import { isIP } from "node:net";

export class PrivateHostError extends Error {
  constructor(host: string) {
    super(`refusing to connect to private address ${host}`);
    this.name = "PrivateHostError";
  }
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Groups(value: string): number[] | null {
  const [headPart, tailPart] = value.split("::");
  const parse = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (group === "") return null;
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(headPart ?? "");
  if (head === null) return null;
  if (tailPart === undefined) return head;
  const tail = parse(tailPart);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function isPrivateIpv6(groups: number[]): boolean {
  const [g0, g1] = groups;
  const allZero = groups.every((group) => group === 0);
  if (allZero) return true;
  if (g0 === 0 && g1 === 0 && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const octets = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return isPrivateIpv4(octets);
  }
  return false;
}

export function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets ? isPrivateIpv4(octets) : true;
  }
  if (family === 6) {
    const groups = parseIpv6Groups(address.toLowerCase());
    return groups ? isPrivateIpv6(groups) : true;
  }
  return true;
}

export function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (normalized === "") return true;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(normalized) === 0) return false;
  return isPrivateIp(normalized);
}

export function assertPublicHost(host: string): void {
  if (isPrivateHost(host)) {
    throw new PrivateHostError(host);
  }
}
