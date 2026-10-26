export type ExternalInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | null;
  cache?: RequestCache;
  signal?: AbortSignal;
};

export type ExternalFetch = (url: string, init?: ExternalInit) => Promise<Response>;
