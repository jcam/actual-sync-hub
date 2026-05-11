import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ConnectionDto,
  HomeValueConnectionDetailsDto,
  HomeValuesFetchMethod,
  HomeValuesProviderSettingsDto,
  HomeValueEstimateStateDto,
  HomeValueSource,
  ProviderConnectResult,
  UpsertHomeValueConnectionPayload
} from "@actual-sync/shared";
import { prisma } from "../db.js";
import { encryptString } from "../lib/crypto.js";
import { parseConnectionMetadata } from "./connection-metadata.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { clearSyncHealth, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;
type FetchMode = "force" | "scheduled" | "cached";
type SourceKey = "redfin" | "movoto" | "homes" | "trulia";
type EstimateField = "redfinEstimate" | "movotoEstimate" | "homesEstimate" | "truliaEstimate";
type UrlField = "redfinUrl" | "movotoUrl" | "homesUrl" | "truliaUrl";

type SourceStateMap = {
  redfin: HomeValueEstimateStateDto;
  movoto: HomeValueEstimateStateDto;
  homes: HomeValueEstimateStateDto;
  trulia: HomeValueEstimateStateDto;
};

type HomeValuesMetadata = {
  homeValues?: HomeValueConnectionDetailsDto | null;
  health?: ConnectionDto["health"] | null;
} & Record<string, unknown>;

type FetchableSourceConfig = {
  source: Exclude<HomeValueSource, "AVERAGE">;
  key: SourceKey;
  estimateField: EstimateField;
  urlField: UrlField;
  validateUrl: (url: string) => string;
  headers: Record<string, string>;
  parseEstimate: (html: string) => number;
};

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFileErrorLike = Error & {
  stdout?: string;
  stderr?: string;
};

type ExecFileLike = (
  file: string,
  args: string[],
  options?: {
    timeout?: number;
    maxBuffer?: number;
  }
) => Promise<ExecFileResult>;

class HomeValueFetchError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "HomeValueFetchError";
    this.retryable = retryable;
  }
}

const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const weeklyRefreshMs = 7 * 24 * 60 * 60 * 1000;
const staleEstimateMs = 14 * 24 * 60 * 60 * 1000;
const providerPacingMs = 60 * 60 * 1000;
const commandTimeoutMs = 20_000;
const commandMaxBuffer = 10 * 1024 * 1024;

const redfinEstimateJsonPattern = /(?:^|[{"\\])avmInfo\\?":\{[^}]*?predictedValue\\?":([0-9.]+)/;
const redfinEstimateTextPattern = /Redfin Estimate[\s\S]{0,600}?\$([0-9][0-9,]*)/i;
const movotoEstimateTextPattern = /Estimated value[\s\S]{0,200}?\$([0-9][0-9,]*)/i;
const homesEstimateRangePattern = /\$([0-9][0-9,]*)\s*[–-]\s*\$([0-9][0-9,]*)/;
const truliaEstimateTextPattern = /Trulia Estimate[\s\S]{0,400}?\$([0-9][0-9,]*)/i;

const redfinHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": browserUserAgent
};

const homesHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "user-agent": browserUserAgent
};

const truliaHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "user-agent": browserUserAgent
};

const movotoHeaders = {
  dnt: "1",
  referer: "https://www.movoto.com/for-sale/",
  "upgrade-insecure-requests": "1",
  "user-agent": browserUserAgent,
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"'
};

const fetchableSourceConfigs: FetchableSourceConfig[] = [
  {
    source: "REDFIN",
    key: "redfin",
    estimateField: "redfinEstimate",
    urlField: "redfinUrl",
    validateUrl: url => validateUrlForHost(url, "redfin.com", "Redfin"),
    headers: redfinHeaders,
    parseEstimate: html => {
      const jsonMatch = html.match(redfinEstimateJsonPattern);
      const textMatch = html.match(redfinEstimateTextPattern);
      const amount =
        (jsonMatch?.[1] ? Number(jsonMatch[1]) : null) ??
        (textMatch?.[1] ? parseEstimateAmount(textMatch[1]) : null);
      if (amount == null || !Number.isFinite(amount)) {
        throw new Error("Could not parse a Redfin estimate from the property page.");
      }
      return Number(amount.toFixed(2));
    }
  },
  {
    source: "MOVOTO",
    key: "movoto",
    estimateField: "movotoEstimate",
    urlField: "movotoUrl",
    validateUrl: url => validateUrlForHost(url, "movoto.com", "Movoto"),
    headers: movotoHeaders,
    parseEstimate: html => {
      const textMatch = html.match(movotoEstimateTextPattern);
      const amount = textMatch?.[1] ? parseEstimateAmount(textMatch[1]) : null;
      if (amount == null || !Number.isFinite(amount)) {
        throw new Error("Could not parse a Movoto estimate from the property page.");
      }
      return Number(amount.toFixed(2));
    }
  },
  {
    source: "HOMES_COM",
    key: "homes",
    estimateField: "homesEstimate",
    urlField: "homesUrl",
    validateUrl: url => validateUrlForHost(url, "homes.com", "Homes.com"),
    headers: homesHeaders,
    parseEstimate: html => {
      const rangeMatch = html.match(homesEstimateRangePattern);
      const lower = rangeMatch?.[1] ? parseEstimateAmount(rangeMatch[1]) : null;
      const upper = rangeMatch?.[2] ? parseEstimateAmount(rangeMatch[2]) : null;
      if (lower == null || upper == null) {
        throw new Error("Could not parse a Homes.com estimate range from the property page.");
      }
      return Number(((lower + upper) / 2).toFixed(2));
    }
  },
  {
    source: "TRULIA",
    key: "trulia",
    estimateField: "truliaEstimate",
    urlField: "truliaUrl",
    validateUrl: url => validateUrlForHost(url, "trulia.com", "Trulia"),
    headers: truliaHeaders,
    parseEstimate: html => {
      const textMatch = html.match(truliaEstimateTextPattern);
      const amount = textMatch?.[1] ? parseEstimateAmount(textMatch[1]) : null;
      if (amount == null || !Number.isFinite(amount)) {
        throw new Error("Could not parse a Trulia estimate from the property page.");
      }
      return Number(amount.toFixed(2));
    }
  }
];

function emptySourceState(url?: string | null, estimate?: number | null): HomeValueEstimateStateDto {
  return {
    url: url ?? null,
    estimate: estimate ?? null,
    lastFetchedAt: null,
    lastSuccessfulAt: null,
    lastFailedAt: null,
    lastFailureMessage: null,
    usingCachedEstimate: false,
    stale: false
  };
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePropertyUrl(value: string | null | undefined) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function normalizeOptionalNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHomeValuesPayload(payload: UpsertHomeValueConnectionPayload): UpsertHomeValueConnectionPayload {
  return {
    label: normalizeOptionalString(payload.label),
    address: payload.address.trim(),
    source: payload.source,
    redfinEstimate: normalizeOptionalNumber(payload.redfinEstimate),
    redfinUrl: normalizePropertyUrl(payload.redfinUrl),
    movotoEstimate: normalizeOptionalNumber(payload.movotoEstimate),
    movotoUrl: normalizePropertyUrl(payload.movotoUrl),
    homesEstimate: normalizeOptionalNumber(payload.homesEstimate),
    homesUrl: normalizePropertyUrl(payload.homesUrl),
    truliaEstimate: normalizeOptionalNumber(payload.truliaEstimate),
    truliaUrl: normalizePropertyUrl(payload.truliaUrl)
  };
}

function parseEstimateAmount(value: string) {
  const amount = Number(value.replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function validateUrlForHost(url: string, hostnameSuffix: string, sourceName: string) {
  try {
    const parsed = new URL(normalizePropertyUrl(url) ?? url);
    if (!parsed.hostname.endsWith(hostnameSuffix)) {
      throw new Error(`${sourceName} URL must point to ${hostnameSuffix}.`);
    }
    return parsed.toString();
  } catch {
    throw new Error(`${sourceName} URL must be a valid ${sourceName} property page URL.`);
  }
}

function requiredUrlMessage(source: Exclude<HomeValueSource, "AVERAGE">) {
  return `${sourceLabel(source)} URL is required when ${sourceLabel(source)} is the selected source.`;
}

function validateHomeValuePayload(payload: UpsertHomeValueConnectionPayload) {
  if (!payload.address) {
    throw new Error("Address is required.");
  }

  const providedSources = fetchableSourceConfigs.filter(config => {
    const url = payload[config.urlField];
    return typeof url === "string" && url.length > 0;
  });

  if (payload.source === "AVERAGE" && providedSources.length === 0) {
    throw new Error(
      "At least one property URL is required when Average all available estimates is the selected source."
    );
  }

  for (const config of fetchableSourceConfigs) {
    const url = payload[config.urlField];
    if (!url) {
      if (payload.source === config.source) {
        throw new Error(requiredUrlMessage(config.source));
      }
      continue;
    }

    config.validateUrl(url);
  }
}

function toTimestamp(date: Date) {
  return date.toISOString();
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toFetchedAtDate(value: string | null | undefined) {
  const parsed = parseTimestamp(value);
  return parsed == null ? null : new Date(parsed);
}

function buildFetchedAtColumns(details: HomeValueConnectionDetailsDto) {
  return {
    homeValuesRedfinLastFetchedAt: toFetchedAtDate(details.sources?.redfin?.lastFetchedAt ?? null),
    homeValuesMovotoLastFetchedAt: toFetchedAtDate(details.sources?.movoto?.lastFetchedAt ?? null),
    homeValuesHomesLastFetchedAt: toFetchedAtDate(details.sources?.homes?.lastFetchedAt ?? null),
    homeValuesTruliaLastFetchedAt: toFetchedAtDate(details.sources?.trulia?.lastFetchedAt ?? null)
  };
}

function isOlderThan(value: string | null | undefined, nowMs: number, thresholdMs: number) {
  const parsed = parseTimestamp(value);
  return parsed == null || nowMs - parsed >= thresholdMs;
}

function buildSourceStates(payload: UpsertHomeValueConnectionPayload, existingDetails?: HomeValueConnectionDetailsDto | null): SourceStateMap {
  const existingSources = existingDetails?.sources ?? {};
  return {
    redfin: {
      ...emptySourceState(payload.redfinUrl ?? null, payload.redfinEstimate ?? null),
      ...(existingSources.redfin ?? {}),
      url: payload.redfinUrl ?? null,
      estimate: payload.redfinEstimate ?? existingSources.redfin?.estimate ?? null
    },
    movoto: {
      ...emptySourceState(payload.movotoUrl ?? null, payload.movotoEstimate ?? null),
      ...(existingSources.movoto ?? {}),
      url: payload.movotoUrl ?? null,
      estimate: payload.movotoEstimate ?? existingSources.movoto?.estimate ?? null
    },
    homes: {
      ...emptySourceState(payload.homesUrl ?? null, payload.homesEstimate ?? null),
      ...(existingSources.homes ?? {}),
      url: payload.homesUrl ?? null,
      estimate: payload.homesEstimate ?? existingSources.homes?.estimate ?? null
    },
    trulia: {
      ...emptySourceState(payload.truliaUrl ?? null, payload.truliaEstimate ?? null),
      ...(existingSources.trulia ?? {}),
      url: payload.truliaUrl ?? null,
      estimate: payload.truliaEstimate ?? existingSources.trulia?.estimate ?? null
    }
  };
}

function clearSourceStateIfRemoved(state: HomeValueEstimateStateDto) {
  if (!state.url) {
    return emptySourceState(null, null);
  }
  return state;
}

function isRetryableStatus(status: number) {
  return status >= 500 && status < 600;
}

function parseCurlResponse(stdout: string) {
  const marker = "\n__STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error("curl response did not include an HTTP status marker.");
  }

  const body = stdout.slice(0, markerIndex);
  const status = Number(stdout.slice(markerIndex + marker.length).trim());
  if (!Number.isFinite(status)) {
    throw new Error("curl response included an invalid HTTP status.");
  }

  return { body, status };
}

function parseWgetStatus(stderr: string) {
  const matches = [...stderr.matchAll(/HTTP\/[0-9.]+\s+(\d{3})\b/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new Error("wget response did not include an HTTP status.");
  }

  return Number(last[1]);
}

async function fetchHtmlWithNodeFetch(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  return {
    status: response.status,
    body
  };
}

async function fetchHtmlWithCurl(url: string, headers: Record<string, string>, execFileImpl: ExecFileLike) {
  const args = ["-sS", "-L", "--compressed", "--max-time", "20", "-w", "\n__STATUS__:%{http_code}"];

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }

  args.push(url);

  const { stdout } = await execFileImpl("curl", args, {
    timeout: commandTimeoutMs,
    maxBuffer: commandMaxBuffer
  });
  return parseCurlResponse(stdout);
}

async function fetchHtmlWithWget(url: string, headers: Record<string, string>, execFileImpl: ExecFileLike) {
  const args = ["-q", "-S", "-O", "-", "--timeout=20"];

  for (const [name, value] of Object.entries(headers)) {
    if (name === "user-agent") {
      args.push(`--user-agent=${value}`);
    } else {
      args.push(`--header=${name}: ${value}`);
    }
  }

  args.push(url);

  try {
    const { stdout, stderr } = await execFileImpl("wget", args, {
      timeout: commandTimeoutMs,
      maxBuffer: commandMaxBuffer
    });

    return {
      status: parseWgetStatus(stderr),
      body: stdout
    };
  } catch (error) {
    const execError = error as ExecFileErrorLike;
    if (typeof execError.stderr === "string") {
      return {
        status: parseWgetStatus(execError.stderr),
        body: typeof execError.stdout === "string" ? execError.stdout : ""
      };
    }
    throw error;
  }
}

async function fetchHtml(
  method: HomeValuesFetchMethod,
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  execFileImpl: ExecFileLike
) {
  switch (method) {
    case "disabled":
      throw new HomeValueFetchError("Home Values fetching is disabled in provider settings.", false);
    case "node_fetch":
      return fetchHtmlWithNodeFetch(url, headers, fetchImpl);
    case "curl":
      return fetchHtmlWithCurl(url, headers, execFileImpl);
    case "wget":
      return fetchHtmlWithWget(url, headers, execFileImpl);
  }
}

async function fetchEstimate(
  url: string,
  config: FetchableSourceConfig,
  fetchImpl: typeof fetch,
  execFileImpl: ExecFileLike,
  fetchMethod: HomeValuesFetchMethod
) {
  const validatedUrl = config.validateUrl(url);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchHtml(fetchMethod, validatedUrl, config.headers, fetchImpl, execFileImpl);
      if (response.status < 200 || response.status >= 300) {
        throw new HomeValueFetchError(
          `${sourceLabel(config.source)} property page fetch failed with status ${response.status}.`,
          isRetryableStatus(response.status)
        );
      }
      return {
        url: validatedUrl,
        estimate: config.parseEstimate(response.body)
      };
    } catch (error) {
      const retryable =
        error instanceof HomeValueFetchError
          ? error.retryable
          : error instanceof TypeError || error instanceof DOMException;
      lastError = error instanceof Error ? error : new Error("Unknown fetch failure");
      if (!retryable || attempt === 1) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Unknown fetch failure");
}

function getFetchMethodForSource(settings: HomeValuesProviderSettingsDto, sourceKey: SourceKey): HomeValuesFetchMethod {
  switch (sourceKey) {
    case "redfin":
      return settings.redfinFetchMethod;
    case "movoto":
      return settings.movotoFetchMethod;
    case "homes":
      return settings.homesFetchMethod;
    case "trulia":
      return settings.truliaFetchMethod;
  }
}

function toPayloadFromStates(
  base: Pick<UpsertHomeValueConnectionPayload, "label" | "address" | "source">,
  sourceStates: SourceStateMap
): UpsertHomeValueConnectionPayload {
  return {
    ...base,
    redfinEstimate: sourceStates.redfin.estimate ?? null,
    redfinUrl: sourceStates.redfin.url ?? null,
    movotoEstimate: sourceStates.movoto.estimate ?? null,
    movotoUrl: sourceStates.movoto.url ?? null,
    homesEstimate: sourceStates.homes.estimate ?? null,
    homesUrl: sourceStates.homes.url ?? null,
    truliaEstimate: sourceStates.trulia.estimate ?? null,
    truliaUrl: sourceStates.trulia.url ?? null
  };
}

function estimateEntries(details: Pick<
  UpsertHomeValueConnectionPayload,
  "redfinEstimate" | "movotoEstimate" | "homesEstimate" | "truliaEstimate"
>) {
  return [
    ["REDFIN", details.redfinEstimate],
    ["MOVOTO", details.movotoEstimate],
    ["HOMES_COM", details.homesEstimate],
    ["TRULIA", details.truliaEstimate]
  ] as const;
}

function calculateHomeValue(details: UpsertHomeValueConnectionPayload) {
  switch (details.source) {
    case "REDFIN":
      if (details.redfinEstimate == null) {
        throw new Error("A Redfin estimate could not be fetched for this property.");
      }
      return details.redfinEstimate;
    case "MOVOTO":
      if (details.movotoEstimate == null) {
        throw new Error("A Movoto estimate could not be fetched for this property.");
      }
      return details.movotoEstimate;
    case "HOMES_COM":
      if (details.homesEstimate == null) {
        throw new Error("A Homes.com estimate could not be fetched for this property.");
      }
      return details.homesEstimate;
    case "TRULIA":
      if (details.truliaEstimate == null) {
        throw new Error("A Trulia estimate could not be fetched for this property.");
      }
      return details.truliaEstimate;
    case "AVERAGE": {
      const estimates = estimateEntries(details)
        .map(([, amount]) => amount)
        .filter((amount): amount is number => amount != null);
      if (estimates.length < 1) {
        throw new Error("At least one home value estimate must be available to calculate an average.");
      }
      return Number((estimates.reduce((sum, amount) => sum + amount, 0) / estimates.length).toFixed(2));
    }
  }
}

function sourceLabel(source: HomeValueSource | Exclude<HomeValueSource, "AVERAGE">) {
  switch (source) {
    case "REDFIN":
      return "Redfin";
    case "MOVOTO":
      return "Movoto";
    case "HOMES_COM":
      return "Homes.com";
    case "TRULIA":
      return "Trulia";
    case "AVERAGE":
      return "Average";
  }
}

function buildHomeValuesNotes(details: HomeValueConnectionDetailsDto) {
  const lines = [`Address: ${details.address}`, `Selected source: ${sourceLabel(details.source)}`];
  for (const [source, amount] of estimateEntries(details)) {
    if (amount != null) {
      lines.push(`${sourceLabel(source)} estimate: $${amount.toFixed(2)}`);
    }
  }
  for (const [label, state] of [
    ["Redfin", details.sources?.redfin],
    ["Movoto", details.sources?.movoto],
    ["Homes.com", details.sources?.homes],
    ["Trulia", details.sources?.trulia]
  ] as const) {
    if (state?.url) {
      lines.push(`${label} URL: ${state.url}`);
    }
    if (state?.lastFailureMessage) {
      lines.push(`${label} fetch warning: ${state.lastFailureMessage}`);
    }
  }
  if (details.calculatedValue != null) {
    lines.push(`Applied home value: $${details.calculatedValue.toFixed(2)}`);
  }
  return lines.join("\n");
}

function toPersistedDetails(
  payload: UpsertHomeValueConnectionPayload,
  timestamp: string,
  sourceStates: SourceStateMap
): HomeValueConnectionDetailsDto {
  return {
    address: payload.address,
    source: payload.source,
    redfinEstimate: sourceStates.redfin.estimate ?? null,
    redfinUrl: sourceStates.redfin.url ?? null,
    movotoEstimate: sourceStates.movoto.estimate ?? null,
    movotoUrl: sourceStates.movoto.url ?? null,
    homesEstimate: sourceStates.homes.estimate ?? null,
    homesUrl: sourceStates.homes.url ?? null,
    truliaEstimate: sourceStates.trulia.estimate ?? null,
    truliaUrl: sourceStates.trulia.url ?? null,
    sources: sourceStates,
    calculatedValue: calculateHomeValue(toPayloadFromStates(payload, sourceStates)),
    lastCalculatedAt: timestamp
  };
}

function sourceWasDueForScheduledFetch(state: HomeValueEstimateStateDto, nowMs: number) {
  const lastSuccessMs = parseTimestamp(state.lastSuccessfulAt);
  return lastSuccessMs == null || nowMs - lastSuccessMs >= weeklyRefreshMs;
}

async function resolveSourceStates({
  payload,
  existingDetails,
  mode,
  fetchImpl,
  execFileImpl,
  fetchMethods,
  now,
  getLatestFetchAt
}: {
  payload: UpsertHomeValueConnectionPayload;
  existingDetails?: HomeValueConnectionDetailsDto | null;
  mode: FetchMode;
  fetchImpl: typeof fetch;
  execFileImpl: ExecFileLike;
  fetchMethods: HomeValuesProviderSettingsDto;
  now: Date;
  getLatestFetchAt: (key: SourceKey) => Promise<number | null>;
}) {
  const timestamp = toTimestamp(now);
  const nowMs = now.getTime();
  const sourceStates = buildSourceStates(payload, existingDetails);

  for (const key of Object.keys(sourceStates) as SourceKey[]) {
    sourceStates[key] = clearSourceStateIfRemoved(sourceStates[key]);
  }

  for (const config of fetchableSourceConfigs) {
    const state = sourceStates[config.key];
    if (!state.url) {
      continue;
    }

    const shouldTryFetch =
      mode === "force" ||
      (mode === "scheduled" && sourceWasDueForScheduledFetch(state, nowMs));
    if (!shouldTryFetch) {
      state.usingCachedEstimate = false;
      state.stale = isOlderThan(state.lastSuccessfulAt, nowMs, staleEstimateMs);
      continue;
    }

    if (mode === "scheduled") {
      const latestFetchAt = await getLatestFetchAt(config.key);
      if (latestFetchAt != null && nowMs - latestFetchAt < providerPacingMs) {
        state.stale = isOlderThan(state.lastSuccessfulAt, nowMs, staleEstimateMs);
        continue;
      }
    }

    try {
      const fetched = await fetchEstimate(
        state.url,
        config,
        fetchImpl,
        execFileImpl,
        getFetchMethodForSource(fetchMethods, config.key)
      );
      state.url = fetched.url;
      state.estimate = fetched.estimate;
      state.lastFetchedAt = timestamp;
      state.lastSuccessfulAt = timestamp;
      state.lastFailedAt = null;
      state.lastFailureMessage = null;
      state.usingCachedEstimate = false;
      state.stale = false;
    } catch (error) {
      state.lastFetchedAt = timestamp;
      state.lastFailedAt = timestamp;
      state.lastFailureMessage = error instanceof Error ? error.message : "Unknown fetch failure";
      state.usingCachedEstimate = state.estimate != null;
      state.stale = isOlderThan(state.lastSuccessfulAt, nowMs, staleEstimateMs);
      if (
        state.estimate == null &&
        mode !== "scheduled" &&
        payload.source !== "AVERAGE" &&
        payload.source === config.source
      ) {
        throw error;
      }
    }
  }

  for (const key of Object.keys(sourceStates) as SourceKey[]) {
    const state = sourceStates[key];
    state.stale = state.estimate != null && isOlderThan(state.lastSuccessfulAt, nowMs, staleEstimateMs);
  }

  return sourceStates;
}

function fromRawDetails(rawDetails: HomeValueConnectionDetailsDto): UpsertHomeValueConnectionPayload {
  return normalizeHomeValuesPayload({
    label: null,
    address: rawDetails.address,
    source: rawDetails.source,
    redfinEstimate: rawDetails.redfinEstimate ?? null,
    redfinUrl: rawDetails.redfinUrl ?? null,
    movotoEstimate: rawDetails.movotoEstimate ?? null,
    movotoUrl: rawDetails.movotoUrl ?? null,
    homesEstimate: rawDetails.homesEstimate ?? null,
    homesUrl: rawDetails.homesUrl ?? null,
    truliaEstimate: rawDetails.truliaEstimate ?? null,
    truliaUrl: rawDetails.truliaUrl ?? null
  });
}

export type HomeValuesService = ProviderAdapter & {
  createConnection(payload: UpsertHomeValueConnectionPayload): Promise<ProviderConnectResult>;
  updateConnection(connectionId: string, payload: UpsertHomeValueConnectionPayload): Promise<ProviderConnectResult>;
};

export function createHomeValuesService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  now = () => new Date(),
  fetchImpl = fetch,
  execFileImpl = promisify(execFile)
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  execFileImpl?: ExecFileLike;
} = {}): HomeValuesService {
  const getEffectiveSettings = async () => {
    const settings = await providerSettings.getAll();
    return (
      settings.HOME_VALUES ?? {
        automaticSyncConcurrency: 1,
        redfinFetchMethod: "curl" as const,
        movotoFetchMethod: "curl" as const,
        homesFetchMethod: "wget" as const,
        truliaFetchMethod: "wget" as const
      }
    );
  };

  const getLatestFetchAt = async (sourceKey: SourceKey, currentConnectionId?: string) => {
    const aggregate = await database.connection.aggregate({
      where: {
        provider: "HOME_VALUES",
        ...(currentConnectionId
          ? {
              id: {
                not: currentConnectionId
              }
            }
          : {})
      },
      _max: {
        homeValuesRedfinLastFetchedAt: true,
        homeValuesMovotoLastFetchedAt: true,
        homeValuesHomesLastFetchedAt: true,
        homeValuesTruliaLastFetchedAt: true
      }
    });
    return parseTimestamp(
      sourceKey === "redfin"
        ? aggregate._max.homeValuesRedfinLastFetchedAt?.toISOString() ?? null
        : sourceKey === "movoto"
          ? aggregate._max.homeValuesMovotoLastFetchedAt?.toISOString() ?? null
          : sourceKey === "homes"
            ? aggregate._max.homeValuesHomesLastFetchedAt?.toISOString() ?? null
            : aggregate._max.homeValuesTruliaLastFetchedAt?.toISOString() ?? null
    );
  };

  const persistConnectionDetails = async ({
    connectionId,
    label,
    details
  }: {
    connectionId: string;
    label?: string | null;
    details: HomeValueConnectionDetailsDto;
  }) => {
    await database.connection.update({
      where: { id: connectionId },
      data: {
        label: label?.trim() || details.address,
        status: "ACTIVE",
        institutionName: "Home Values",
        institutionId: "home-values",
        lastRefreshedAt: now(),
        ...buildFetchedAtColumns(details),
        metadataJson: JSON.stringify({
          homeValues: details,
          health: clearSyncHealth()
        } satisfies HomeValuesMetadata),
        accounts: {
          updateMany: {
            where: {},
            data: {
              name: label?.trim() || details.address,
              officialName: details.address,
              type: "property",
              subtype: "home-value",
              currentBalance: details.calculatedValue ?? null,
              availableBalance: null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      }
    });
  };

  const resolveDetails = async ({
    payload,
    existingDetails,
    mode,
    currentConnectionId
  }: {
    payload: UpsertHomeValueConnectionPayload;
    existingDetails?: HomeValueConnectionDetailsDto | null;
    mode: FetchMode;
    currentConnectionId?: string;
  }) => {
    const effectiveNow = now();
    const effectiveSettings = await getEffectiveSettings();
    const sourceStates =
      mode === "cached"
        ? buildSourceStates(payload, existingDetails)
        : await resolveSourceStates({
            payload,
            existingDetails,
            mode,
            fetchImpl,
            execFileImpl,
            fetchMethods: effectiveSettings,
            now: effectiveNow,
            getLatestFetchAt: key => getLatestFetchAt(key, currentConnectionId)
          });
    return toPersistedDetails(payload, toTimestamp(effectiveNow), sourceStates);
  };

  const readPersistedConnectionDetails = async (
    connection: {
      id: string;
      provider: string;
      metadataJson: string | null;
    },
    mode: FetchMode
  ) => {
    if (connection.provider !== "HOME_VALUES") {
      throw new Error("Connection is not a Home Values connection");
    }

    const metadata = parseConnectionMetadata(connection.metadataJson) as HomeValuesMetadata;
    const rawDetails = metadata.homeValues;
    if (!rawDetails?.address || !rawDetails.source) {
      throw new Error("Home Values connection is missing address or source details.");
    }

    const payload = fromRawDetails(rawDetails);
    const details = await resolveDetails({
      payload,
      existingDetails: rawDetails,
      mode,
      currentConnectionId: connection.id
    });

    return {
      metadata,
      details
    };
  };

  return {
    provider: "HOME_VALUES",
    isConfigured() {
      return true;
    },
    async createConnection(payload) {
      await getEffectiveSettings();
      const normalizedPayload = normalizeHomeValuesPayload(payload);
      validateHomeValuePayload(normalizedPayload);
      const details = await resolveDetails({
        payload: normalizedPayload,
        mode: "force"
      });
      const label = normalizedPayload.label?.trim() || normalizedPayload.address;

      const connection = await database.connection.create({
        data: {
          provider: "HOME_VALUES",
          label,
          status: "ACTIVE",
          institutionName: "Home Values",
          institutionId: "home-values",
          accessTokenCiphertext: encryptString("manual-home-values"),
          providerItemId: randomUUID(),
          lastRefreshedAt: now(),
          ...buildFetchedAtColumns(details),
          metadataJson: JSON.stringify({
            homeValues: details,
            health: clearSyncHealth()
          } satisfies HomeValuesMetadata),
          accounts: {
            create: {
              externalAccountId: randomUUID(),
              name: label,
              officialName: normalizedPayload.address,
              type: "property",
              subtype: "home-value",
              currentBalance: details.calculatedValue ?? null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      });

      return { connectionId: connection.id };
    },

    async updateConnection(connectionId, payload) {
      const existing = await database.connection.findUniqueOrThrow({
        where: { id: connectionId }
      });
      const existingMetadata = parseConnectionMetadata(existing.metadataJson) as HomeValuesMetadata;
      const normalizedPayload = normalizeHomeValuesPayload(payload);
      validateHomeValuePayload(normalizedPayload);
      const details = await resolveDetails({
        payload: normalizedPayload,
        existingDetails: existingMetadata.homeValues ?? null,
        mode: "force",
        currentConnectionId: connectionId
      });
      await persistConnectionDetails({
        connectionId,
        label: payload.label,
        details
      });

      return { connectionId };
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: { id: connectionId }
      });

      try {
        const { details } = await readPersistedConnectionDetails(connection, "force");
        await persistConnectionDetails({ connectionId, details });
      } catch (error) {
        const metadata = parseConnectionMetadata(connection.metadataJson) as HomeValuesMetadata;
        await database.connection.update({
          where: { id: connectionId },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health: toSyncHealth(error, {
                scope: "SYNC_PIPELINE",
                action: "CHECK_PROVIDER"
              })
            } satisfies HomeValuesMetadata)
          }
        });
        throw error;
      }
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const link = await database.accountLink.findUniqueOrThrow({
        where: { id: linkId },
        include: {
          connection: true,
          connectionAccount: true
        }
      });

      if (!link.connection || !link.connectionAccount) {
        return { imported: 0, transactions: [], removedImportedIds: [] };
      }

      const mode: FetchMode = link.syncFrequency === "MANUAL" ? "cached" : "scheduled";
      const { details } = await readPersistedConnectionDetails(link.connection, mode);
      await persistConnectionDetails({
        connectionId: link.connection.id,
        details
      });

      return sanitizeProviderSyncResult({
        imported: 1,
        transactions: [
          {
            date: now().toISOString().slice(0, 10),
            amount: details.calculatedValue ?? 0,
            payeeName: link.connection.label,
            importedPayee: details.address,
            notes: buildHomeValuesNotes(details),
            importedId: `home-value:${link.connectionAccount.externalAccountId}`,
            cleared: true,
            searchText: [
              details.address,
              details.redfinUrl || undefined,
              details.movotoUrl || undefined,
              details.homesUrl || undefined,
              details.truliaUrl || undefined
            ].filter((value): value is string => Boolean(value))
          }
        ],
        removedImportedIds: []
      });
    }
  };
}

export const homeValuesService = createHomeValuesService();
