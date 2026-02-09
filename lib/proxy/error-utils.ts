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

export type ProxyErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_error";

export function getSanitizedProxyError(statusCode: number): {
  type: ProxyErrorType;
  message: string;
} {
  if (statusCode === 400 || statusCode === 422) {
    return {
      type: "invalid_request_error",
      message: "Invalid request parameters.",
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      type: "authentication_error",
      message: "Provider authentication failed. Please re-authenticate your account.",
    };
  }

  if (statusCode === 408) {
    return {
      type: "api_error",
      message: "Provider request timed out. Please retry.",
    };
  }

  if (statusCode === 429) {
    return {
      type: "rate_limit_error",
      message: "Provider rate limit reached. Please retry shortly.",
    };
  }

  if (statusCode >= 500) {
    return {
      type: "api_error",
      message: "Provider service temporarily unavailable.",
    };
  }

  return {
    type: "api_error",
    message: `Provider request failed (HTTP ${statusCode}).`,
  };
}
