import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici/index.js";
import { PrivateHostError, isPrivate } from "@opendum/core/egress/ssrf";

export type GuardedFetchOptions = {
  headersTimeout?: number;
  connectTimeout?: number;
};

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FetchHandle = {
  fetch: Fetch;
  close(): Promise<void>;
};

type LookupAddress = { address: string; family: number };

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;

const CONNECT_TIMEOUT_MS = 15000;

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
      if (isPrivate(entry.address)) {
        callback(new PrivateHostError(entry.address), undefined, undefined);
        return;
      }
    }
    callback(null, address as string, family as number);
  });
}

export function guardedFetch(options: GuardedFetchOptions = {}): FetchHandle {
  const connectTimeout = options.connectTimeout ?? CONNECT_TIMEOUT_MS;
  const connectWithLookup = buildConnector({
    lookup: guardedLookup as never,
    timeout: connectTimeout,
  });
  const connection: typeof connectWithLookup = (connectOptions, callback) => {
    const hostname = connectOptions.hostname ?? connectOptions.host ?? "";
    if (isIP(hostname) !== 0 && isPrivate(hostname)) {
      callback(new PrivateHostError(hostname), null);
      return;
    }
    connectWithLookup(connectOptions, callback);
  };
  const agent = new Agent({
    connect: connection,
    headersTimeout: options.headersTimeout,
  });
  const fetchFn: Fetch = (url, init) =>
    undiciFetch(url, {
      ...(init as UndiciRequestInit),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  return {
    fetch: fetchFn,
    close: () => agent.close(),
  };
}
