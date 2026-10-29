const HEADERS_TIMEOUT_REASON = "upstream headers timed out";

export class HeadersTimeout {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(timeoutMs: number) {
    if (timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.controller.abort(new DOMException(HEADERS_TIMEOUT_REASON, "TimeoutError"));
      }, timeoutMs);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  clear(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export const HEADERS_TIMEOUT_MESSAGE = HEADERS_TIMEOUT_REASON;
