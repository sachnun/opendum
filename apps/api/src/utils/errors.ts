export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface CreateErrorInput {
  statusCode?: number;
  statusMessage?: string;
  message?: string;
}

export function createError(input: number | string | CreateErrorInput, message?: string): HttpError {
  if (typeof input === "number") {
    return new HttpError(input, message ?? "Error");
  }
  if (typeof input === "string") {
    return new HttpError(500, input);
  }
  return new HttpError(input.statusCode ?? 500, input.statusMessage ?? input.message ?? "Error");
}
