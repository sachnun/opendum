import type { Context } from "hono";

export interface ErrorInfo {
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
}

export function formatOpenAIError(status: number, err: ErrorInfo) {
  return {
    error: {
      message: err.message,
      type: err.type,
      param: err.param ?? null,
      code: err.code ?? null,
    },
  };
}

export function writeOpenAIError(c: Context, status: number, err: ErrorInfo) {
  return c.json(formatOpenAIError(status, err), status as any);
}
