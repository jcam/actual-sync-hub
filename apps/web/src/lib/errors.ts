export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getDisplayErrorMessage(
  error: unknown,
  fallback: string,
  options?: {
    serverUnavailableMessage?: string;
  }
) {
  if (error instanceof ApiError) {
    const normalized = error.message.trim().toLowerCase();
    if (!error.message || normalized === "internal server error") {
      return fallback;
    }

    return error.message;
  }

  if (error instanceof Error) {
    const normalized = error.message.trim().toLowerCase();

    if (!error.message || normalized === "internal server error") {
      return fallback;
    }

    if (
      normalized === "failed to fetch" ||
      normalized.includes("networkerror") ||
      normalized.includes("network error")
    ) {
      return options?.serverUnavailableMessage || "Could not reach the API server.";
    }

    return error.message;
  }

  return fallback;
}
