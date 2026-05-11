export class ApiError extends Error {
  status: number;
  issues: Array<{
    path?: Array<string | number>;
    message?: string;
  }> | undefined;

  constructor(
    message: string,
    status: number,
    options?: {
      issues?: Array<{
        path?: Array<string | number>;
        message?: string;
      }>;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = options?.issues;
  }
}

function toFieldLabel(path?: Array<string | number>) {
  if (!path || path.length === 0) {
    return null;
  }

  const [head] = path;
  if (typeof head !== "string" || !head) {
    return null;
  }

  return head
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\burl\b/gi, "URL")
    .replace(/^./, value => value.toUpperCase());
}

function formatIssueMessages(
  issues: Array<{
    path?: Array<string | number>;
    message?: string;
  }>
) {
  const uniqueMessages = new Set<string>();

  for (const issue of issues) {
    const message = issue.message?.trim();
    if (!message) {
      continue;
    }

    const label = toFieldLabel(issue.path);
    const normalized = message.toLowerCase();
    const formatted =
      label && !normalized.startsWith(label.toLowerCase()) ? `${label}: ${message}` : message;
    uniqueMessages.add(formatted);
  }

  return [...uniqueMessages].join(" ");
}

export function getDisplayErrorMessage(
  error: unknown,
  fallback: string,
  options?: {
    serverUnavailableMessage?: string;
  }
) {
  if (error instanceof ApiError) {
    if (error.issues?.length) {
      const formattedIssues = formatIssueMessages(error.issues);
      if (formattedIssues) {
        return formattedIssues;
      }
    }

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
