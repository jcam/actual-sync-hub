export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(json: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(json);
  return isJsonObject(parsed) ? parsed : null;
}

export function parseJsonArray(json: string): unknown[] | null {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : null;
}
