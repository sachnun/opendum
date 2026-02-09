export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }

  return "Unknown error";
}

export function getErrorStatusCode(error: unknown): number {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return status;
    }

    const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
    if (
      typeof responseStatus === "number" &&
      responseStatus >= 400 &&
      responseStatus <= 599
    ) {
      return responseStatus;
    }

    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && code >= 400 && code <= 599) {
      return code;
    }
  }

  const message = getErrorMessage(error);
  const statusMatch = message.match(/\b(?:HTTP\s*)?([45]\d{2})\b/i);
  if (statusMatch) {
    return Number(statusMatch[1]);
  }

  return 500;
}

export function buildAccountErrorMessage(
  errorMessage: string,
  context: {
    model: string;
    parameters?: Record<string, unknown>;
  }
): string {
  const normalizedParameters = Object.fromEntries(
    Object.entries(context.parameters ?? {}).filter(([, value]) => value !== undefined)
  );

  let serializedParameters = "{}";
  try {
    serializedParameters = JSON.stringify(normalizedParameters, null, 2);
  } catch {
    serializedParameters = '"[unserializable parameters]"';
  }

  return [
    `Error: ${errorMessage}`,
    `Model: ${context.model}`,
    `Parameters: ${serializedParameters}`,
  ].join("\n");
}

export function shouldRotateToNextAccount(statusCode: number): boolean {
  return (
    statusCode >= 500 ||
    statusCode === 429 ||
    statusCode === 408 ||
    statusCode === 403 ||
    statusCode === 402 ||
    statusCode === 401
  );
}
