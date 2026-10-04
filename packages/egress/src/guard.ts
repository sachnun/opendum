import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { PrivateHostError, isPrivateIp } from "#egress/ssrf.ts";

export type GuardedFetchOptions = {
  headersTimeout?: number;
  connectTimeout?: number;
};

export type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type GuardedFetcher = {
  fetch: GuardedFetch;
  close(): Promise<void>;
};

type LookupAddress = { address: string; family: number };

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

// Resolves DNS ourselves and rejects private/loopback/link-local results before
// the socket is created, so hostnames that resolve to internal addresses (DNS
// rebinding) are covered. IP literals never reach this hook, so the connector
// below validates them separately.
function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  dnsLookup(hostname, options as never, (error, address, family) => {
    if (error) {
      callback(error, address as string, family as number);
      return;
    }
    const entries: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family as number }];
    for (const entry of entries) {
      if (isPrivateIp(entry.address)) {
        callback(new PrivateHostError(entry.address), undefined, undefined);
        return;
      }
    }
    callback(null, address as string, family as number);
  });
}

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetcher {
  const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connectWithLookup = buildConnector({
    lookup: guardedLookup as never,
    timeout: connectTimeout,
  });
  const connection: typeof connectWithLookup = (connectOptions, callback) => {
    const hostname = connectOptions.hostname ?? connectOptions.host ?? "";
    if (isIP(hostname) !== 0 && isPrivateIp(hostname)) {
      callback(new PrivateHostError(hostname), null);
      return;
    }
    connectWithLookup(connectOptions, callback);
  };
  const agent = new Agent({
    connect: connection,
    headersTimeout: options.headersTimeout,
  });
  const fetchFn: GuardedFetch = (url, init) =>
    undiciFetch(url, {
      ...(init as UndiciRequestInit),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  return {
    fetch: fetchFn,
    close: () => agent.close(),
  };
}
