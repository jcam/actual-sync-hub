import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ConnectionDto,
  HomeValueEstimateStateDto,
  ProviderConnectResult,
  UpsertVehicleValueConnectionPayload,
  VehicleValueConnectionDetailsDto,
  VehicleValuesFetchMethod,
  VehicleValuesProviderSettingsDto
} from "@actual-sync/shared";
import { prisma } from "../db.js";
import { encryptString } from "../lib/crypto.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { parseConnectionMetadata } from "./connection-metadata.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { clearSyncHealth, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;
type FetchMode = "force" | "scheduled" | "cached";
type SourceKey = "kbb" | "edmunds" | "carmax" | "hagerty";
type UrlField = "kbbUrl" | "hagertyUrl";

type SourceStateMap = {
  kbb: HomeValueEstimateStateDto;
  edmunds: HomeValueEstimateStateDto;
  carmax: HomeValueEstimateStateDto;
  hagerty: HomeValueEstimateStateDto;
};

type VehicleValuesMetadata = {
  vehicleValues?: VehicleValueConnectionDetailsDto | null;
  health?: ConnectionDto["health"] | null;
} & Record<string, unknown>;

type FetchableSourceConfig = {
  source: "KBB" | "HAGERTY";
  key: "kbb" | "hagerty";
  valueField: "kbbValue" | "hagertyValue";
  urlField: UrlField;
  validateUrl: (url: string) => string;
  headers: Record<string, string>;
  parseEstimate: (response: FetchPageResult, payload: UpsertVehicleValueConnectionPayload) => number;
};

type FetchPageResult = {
  status: number;
  body: string;
  text: string;
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

type BrowserFetchLike = (url: string) => Promise<FetchPageResult>;

class VehicleValueFetchError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "VehicleValueFetchError";
    this.retryable = retryable;
  }
}

const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const weeklyRefreshMs = 7 * 24 * 60 * 60 * 1000;
const staleEstimateMs = 14 * 24 * 60 * 60 * 1000;
const commandTimeoutMs = 20_000;
const commandMaxBuffer = 10 * 1024 * 1024;
const kbbCurrentResaleValuePattern = /"currentResaleValue":([0-9.]+)/;
const kbbCurrentTradeInValuePattern = /"currentTradeInValue":([0-9.]+)/;
const kbbTrimPattern =
  /"displayName":"([^"]+)"[\s\S]{0,800}?"fppPrice":([0-9.]+)[\s\S]{0,200}?"tradeIn":([0-9.]+)[\s\S]{0,200}?"privateParty":([0-9.]+)/g;
const hagertyGoodConditionPattern = /(?:#3\s+)?Good condition\*?\s*\$([\d,\s]+)/i;

const kbbHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": browserUserAgent
};

const hagertyHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": browserUserAgent
};

const sourceConfig = [
  {
    source: "KBB" as const,
    key: "kbb" as const,
    valueField: "kbbValue" as const
  },
  {
    source: "EDMUNDS" as const,
    key: "edmunds" as const,
    valueField: "edmundsValue" as const
  },
  {
    source: "CARMAX" as const,
    key: "carmax" as const,
    valueField: "carmaxValue" as const
  },
  {
    source: "HAGERTY" as const,
    key: "hagerty" as const,
    valueField: "hagertyValue" as const
  }
];

const fetchableSourceConfigs: FetchableSourceConfig[] = [
  {
    source: "KBB",
    key: "kbb",
    valueField: "kbbValue",
    urlField: "kbbUrl",
    validateUrl: url => validateUrlForHost(url, "kbb.com", "Kelley Blue Book"),
    headers: kbbHeaders,
    parseEstimate: (response, payload) => parseKbbEstimate(response.body, payload)
  },
  {
    source: "HAGERTY",
    key: "hagerty",
    valueField: "hagertyValue",
    urlField: "hagertyUrl",
    validateUrl: url => validateUrlForHost(url, "hagerty.com", "Hagerty"),
    headers: hagertyHeaders,
    parseEstimate: response => parseHagertyEstimate(response.text)
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

function normalizePageUrl(value: string | null | undefined) {
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
}

function normalizeVehicleValuesPayload(payload: UpsertVehicleValueConnectionPayload): UpsertVehicleValueConnectionPayload {
  return {
    label: normalizeOptionalString(payload.label),
    vin: normalizeOptionalString(payload.vin)?.toUpperCase() ?? null,
    year:
      typeof payload.year === "number" && Number.isInteger(payload.year) && payload.year >= 1886 ? payload.year : null,
    make: payload.make.trim(),
    model: payload.model.trim(),
    trim: normalizeOptionalString(payload.trim),
    mileage: typeof payload.mileage === "number" && Number.isFinite(payload.mileage) ? Math.max(0, payload.mileage) : 0,
    zipCode: payload.zipCode.trim(),
    condition: payload.condition,
    source: payload.source,
    kbbValue: normalizeOptionalNumber(payload.kbbValue),
    kbbUrl: normalizePageUrl(payload.kbbUrl),
    edmundsValue: normalizeOptionalNumber(payload.edmundsValue),
    carmaxValue: normalizeOptionalNumber(payload.carmaxValue),
    hagertyValue: normalizeOptionalNumber(payload.hagertyValue),
    hagertyUrl: normalizePageUrl(payload.hagertyUrl)
  };
}

function sourceLabel(source: UpsertVehicleValueConnectionPayload["source"]) {
  switch (source) {
    case "KBB":
      return "Kelley Blue Book";
    case "EDMUNDS":
      return "Edmunds";
    case "CARMAX":
      return "CarMax";
    case "HAGERTY":
      return "Hagerty";
    case "AVERAGE":
      return "Average";
  }
}

function sourceWasDueForScheduledFetch(state: HomeValueEstimateStateDto, nowMs: number) {
  const lastSuccessMs = parseTimestamp(state.lastSuccessfulAt);
  return lastSuccessMs == null || nowMs - lastSuccessMs >= weeklyRefreshMs;
}

function validateUrlForHost(url: string, hostnameSuffix: string, sourceName: string) {
  try {
    const parsed = new URL(normalizePageUrl(url) ?? url);
    if (!parsed.hostname.endsWith(hostnameSuffix)) {
      throw new Error(`${sourceName} URL must point to ${hostnameSuffix}.`);
    }
    return parsed.toString();
  } catch {
    throw new Error(`${sourceName} URL must be a valid ${sourceName} page URL.`);
  }
}

function requiredSourceInputMessage(source: "KBB" | "EDMUNDS" | "CARMAX" | "HAGERTY") {
  const label = sourceLabel(source);
  if (source === "KBB" || source === "HAGERTY") {
    return `${label} value or URL is required when ${label} is the selected source.`;
  }
  return `${label} value is required when ${label} is the selected source.`;
}

function validateVehicleValuePayload(payload: UpsertVehicleValueConnectionPayload) {
  if (!payload.make) {
    throw new Error("Make is required.");
  }
  if (!payload.model) {
    throw new Error("Model is required.");
  }
  if (!payload.zipCode) {
    throw new Error("ZIP code is required.");
  }
  if (!Number.isFinite(payload.mileage) || payload.mileage < 0) {
    throw new Error("Mileage must be zero or greater.");
  }

  for (const config of fetchableSourceConfigs) {
    const url = payload[config.urlField];
    if (url) {
      config.validateUrl(url);
    }
  }

  const availableInputs = sourceConfig.some(config => {
    const value = payload[config.valueField];
    if (typeof value === "number" && Number.isFinite(value)) {
      return true;
    }

    if (config.key === "kbb") {
      return Boolean(payload.kbbUrl);
    }
    if (config.key === "hagerty") {
      return Boolean(payload.hagertyUrl);
    }
    return false;
  });

  if (payload.source === "AVERAGE") {
    if (!availableInputs) {
      throw new Error("At least one source value or source URL is required when Average is the selected source.");
    }
    return;
  }

  if (payload.source === "KBB") {
    if (payload.kbbValue == null && !payload.kbbUrl) {
      throw new Error(requiredSourceInputMessage("KBB"));
    }
    return;
  }

  if (payload.source === "HAGERTY") {
    if (payload.hagertyValue == null && !payload.hagertyUrl) {
      throw new Error(requiredSourceInputMessage("HAGERTY"));
    }
    return;
  }

  const selectedConfig = sourceConfig.find(config => config.source === payload.source);
  if (!selectedConfig) {
    throw new Error("Selected source is invalid.");
  }
  if (payload[selectedConfig.valueField] == null) {
    throw new Error(requiredSourceInputMessage(payload.source));
  }
}

function buildVehicleLabel(details: VehicleValueConnectionDetailsDto) {
  return [details.year ?? null, details.make, details.model, details.trim ?? null].filter(Boolean).join(" ");
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "Not available";
}

function parseEstimateAmount(value: string) {
  const amount = Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function normalizeTextForMatching(value: string | null | undefined) {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function parseKbbEstimate(html: string, payload: UpsertVehicleValueConnectionPayload) {
  const trimTarget = normalizeTextForMatching(payload.trim);
  const trims = [...html.matchAll(kbbTrimPattern)]
    .map(match => ({
      displayName: match[1],
      privateParty: parseEstimateAmount(match[4] ?? ""),
      fppPrice: parseEstimateAmount(match[2] ?? ""),
      tradeIn: parseEstimateAmount(match[3] ?? "")
    }))
    .filter(
      (trim): trim is { displayName: string; privateParty: number | null; fppPrice: number | null; tradeIn: number | null } =>
        Boolean(trim.displayName)
    );

  if (trimTarget) {
    const matchedTrim = trims.find(trim => {
      const normalizedDisplayName = normalizeTextForMatching(trim.displayName);
      return normalizedDisplayName.includes(trimTarget) || trimTarget.includes(normalizedDisplayName);
    });
    const matchedAmount = matchedTrim?.privateParty ?? matchedTrim?.fppPrice ?? matchedTrim?.tradeIn ?? null;
    if (matchedAmount != null) {
      return Number(matchedAmount.toFixed(2));
    }
  }

  const resaleAmount = html.match(kbbCurrentResaleValuePattern)?.[1]
    ? parseEstimateAmount(html.match(kbbCurrentResaleValuePattern)?.[1] ?? "")
    : null;
  if (resaleAmount != null) {
    return Number(resaleAmount.toFixed(2));
  }

  const firstTrimAmount = trims[0]?.privateParty ?? trims[0]?.fppPrice ?? trims[0]?.tradeIn ?? null;
  if (firstTrimAmount != null) {
    return Number(firstTrimAmount.toFixed(2));
  }

  const tradeInAmount = html.match(kbbCurrentTradeInValuePattern)?.[1]
    ? parseEstimateAmount(html.match(kbbCurrentTradeInValuePattern)?.[1] ?? "")
    : null;
  if (tradeInAmount != null) {
    return Number(tradeInAmount.toFixed(2));
  }

  throw new Error("Could not parse a Kelley Blue Book estimate from the vehicle page.");
}

function normalizeHagertyText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function parseHagertyEstimate(text: string) {
  const normalized = normalizeHagertyText(text);
  const match = normalized.match(hagertyGoodConditionPattern);
  const amount = match?.[1] ? parseEstimateAmount(match[1]) : null;
  if (amount == null) {
    throw new Error("Could not parse a Hagerty good-condition estimate from the valuation page.");
  }
  return Number(amount.toFixed(2));
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

function isOlderThan(value: string | null | undefined, nowMs: number, thresholdMs: number) {
  const parsed = parseTimestamp(value);
  return parsed == null || nowMs - parsed >= thresholdMs;
}

function buildSourceStates(
  payload: UpsertVehicleValueConnectionPayload,
  existingDetails?: VehicleValueConnectionDetailsDto | null,
  timestamp?: string
): SourceStateMap {
  const existingSources = existingDetails?.sources ?? {};
  const nextSuccessTimestamp = (
    nextEstimate: number | null | undefined,
    existingState: HomeValueEstimateStateDto | null | undefined
  ) => {
    if (nextEstimate == null) {
      return existingState?.lastSuccessfulAt ?? null;
    }
    if (existingState?.estimate == null || existingState.estimate !== nextEstimate) {
      return timestamp ?? existingState?.lastSuccessfulAt ?? null;
    }
    return existingState.lastSuccessfulAt ?? null;
  };

  const sourceStates: SourceStateMap = {
    kbb: {
      ...emptySourceState(payload.kbbUrl ?? null, payload.kbbValue ?? null),
      ...(existingSources.kbb ?? {}),
      url: payload.kbbUrl ?? null,
      estimate: payload.kbbValue ?? existingSources.kbb?.estimate ?? null,
      lastSuccessfulAt: nextSuccessTimestamp(payload.kbbValue, existingSources.kbb)
    },
    edmunds: {
      ...emptySourceState(null, payload.edmundsValue ?? null),
      ...(existingSources.edmunds ?? {}),
      url: null,
      estimate: payload.edmundsValue ?? existingSources.edmunds?.estimate ?? null,
      lastSuccessfulAt: nextSuccessTimestamp(payload.edmundsValue, existingSources.edmunds)
    },
    carmax: {
      ...emptySourceState(null, payload.carmaxValue ?? null),
      ...(existingSources.carmax ?? {}),
      url: null,
      estimate: payload.carmaxValue ?? existingSources.carmax?.estimate ?? null,
      lastSuccessfulAt: nextSuccessTimestamp(payload.carmaxValue, existingSources.carmax)
    },
    hagerty: {
      ...emptySourceState(payload.hagertyUrl ?? null, payload.hagertyValue ?? null),
      ...(existingSources.hagerty ?? {}),
      url: payload.hagertyUrl ?? null,
      estimate: payload.hagertyValue ?? existingSources.hagerty?.estimate ?? null,
      lastSuccessfulAt: nextSuccessTimestamp(payload.hagertyValue, existingSources.hagerty)
    }
  };

  for (const key of Object.keys(sourceStates) as SourceKey[]) {
    const state = sourceStates[key];
    if (!state.url && state.estimate == null) {
      sourceStates[key] = emptySourceState(null, null);
    }
  }

  return sourceStates;
}

function toPayloadFromStates(
  base: Pick<UpsertVehicleValueConnectionPayload, "label" | "vin" | "year" | "make" | "model" | "trim" | "mileage" | "zipCode" | "condition" | "source">,
  sourceStates: SourceStateMap
): UpsertVehicleValueConnectionPayload {
  return {
    ...base,
    kbbValue: sourceStates.kbb.estimate ?? null,
    kbbUrl: sourceStates.kbb.url ?? null,
    edmundsValue: sourceStates.edmunds.estimate ?? null,
    carmaxValue: sourceStates.carmax.estimate ?? null,
    hagertyValue: sourceStates.hagerty.estimate ?? null,
    hagertyUrl: sourceStates.hagerty.url ?? null
  };
}

function calculateVehicleValue(payload: UpsertVehicleValueConnectionPayload) {
  if (payload.source === "AVERAGE") {
    const values = sourceConfig
      .map(config => payload[config.valueField])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      throw new Error("At least one vehicle value estimate must be available to calculate an average.");
    }
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  }

  const selectedConfig = sourceConfig.find(config => config.source === payload.source);
  const value = selectedConfig ? payload[selectedConfig.valueField] : null;
  if (value == null) {
    throw new Error(`${sourceLabel(payload.source)} value is required to calculate the selected source.`);
  }
  return Number(value.toFixed(2));
}

function buildVehicleValuesNotes(details: VehicleValueConnectionDetailsDto) {
  const lines = [
    `Vehicle: ${buildVehicleLabel(details)}`,
    `Condition: ${details.condition}`,
    `Mileage: ${details.mileage.toLocaleString("en-US")} miles`,
    `ZIP code: ${details.zipCode}`,
    `Selected source: ${sourceLabel(details.source)}`
  ];

  if (details.vin) {
    lines.push(`VIN: ${details.vin}`);
  }

  for (const config of sourceConfig) {
    lines.push(`${sourceLabel(config.source)} value: ${formatMoney(details[config.valueField] ?? null)}`);
  }

  for (const [label, state] of [
    ["Kelley Blue Book", details.sources?.kbb],
    ["Hagerty", details.sources?.hagerty]
  ] as const) {
    if (state?.url) {
      lines.push(`${label} URL: ${state.url}`);
    }
    if (state?.lastFailureMessage) {
      lines.push(`${label} fetch warning: ${state.lastFailureMessage}`);
    }
  }

  if (details.calculatedValue != null) {
    lines.push(`Applied vehicle value: ${details.calculatedValue.toFixed(2)}`);
  }

  return lines.join("\n");
}

function toPersistedDetails(
  payload: UpsertVehicleValueConnectionPayload,
  timestamp: string,
  sourceStates: SourceStateMap
): VehicleValueConnectionDetailsDto {
  return {
    vin: payload.vin ?? null,
    year: payload.year ?? null,
    make: payload.make,
    model: payload.model,
    trim: payload.trim ?? null,
    mileage: payload.mileage,
    zipCode: payload.zipCode,
    condition: payload.condition,
    source: payload.source,
    kbbValue: sourceStates.kbb.estimate ?? null,
    kbbUrl: sourceStates.kbb.url ?? null,
    edmundsValue: sourceStates.edmunds.estimate ?? null,
    carmaxValue: sourceStates.carmax.estimate ?? null,
    hagertyValue: sourceStates.hagerty.estimate ?? null,
    hagertyUrl: sourceStates.hagerty.url ?? null,
    sources: sourceStates,
    calculatedValue: calculateVehicleValue(toPayloadFromStates(payload, sourceStates)),
    lastCalculatedAt: timestamp
  };
}

function fromRawDetails(rawDetails: VehicleValueConnectionDetailsDto): UpsertVehicleValueConnectionPayload {
  return normalizeVehicleValuesPayload({
    label: null,
    vin: rawDetails.vin ?? null,
    year: rawDetails.year ?? null,
    make: rawDetails.make,
    model: rawDetails.model,
    trim: rawDetails.trim ?? null,
    mileage: rawDetails.mileage,
    zipCode: rawDetails.zipCode,
    condition: rawDetails.condition,
    source: rawDetails.source,
    kbbValue: rawDetails.kbbValue ?? null,
    kbbUrl: rawDetails.kbbUrl ?? null,
    edmundsValue: rawDetails.edmundsValue ?? null,
    carmaxValue: rawDetails.carmaxValue ?? null,
    hagertyValue: rawDetails.hagertyValue ?? null,
    hagertyUrl: rawDetails.hagertyUrl ?? null
  });
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

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function isRetryableStatus(status: number) {
  return status >= 500 && status < 600;
}

async function fetchPageWithNodeFetch(url: string, headers: Record<string, string>, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, { headers });
  const body = await response.text();
  return {
    status: response.status,
    body,
    text: htmlToText(body)
  };
}

async function fetchPageWithCurl(url: string, headers: Record<string, string>, execFileImpl: ExecFileLike) {
  const args = ["-sS", "-L", "--compressed", "--max-time", "20", "-w", "\n__STATUS__:%{http_code}"];

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }

  args.push(url);

  const { stdout } = await execFileImpl("curl", args, {
    timeout: commandTimeoutMs,
    maxBuffer: commandMaxBuffer
  });
  const response = parseCurlResponse(stdout);
  return {
    ...response,
    text: htmlToText(response.body)
  };
}

async function fetchPageWithWget(url: string, headers: Record<string, string>, execFileImpl: ExecFileLike) {
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
      body: stdout,
      text: htmlToText(stdout)
    };
  } catch (error) {
    const execError = error as ExecFileErrorLike;
    if (typeof execError.stderr === "string") {
      const body = typeof execError.stdout === "string" ? execError.stdout : "";
      return {
        status: parseWgetStatus(execError.stderr),
        body,
        text: htmlToText(body)
      };
    }
    throw error;
  }
}

async function fetchPageWithBrowser(url: string): Promise<FetchPageResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ userAgent: browserUserAgent });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    const body = await page.content();
    const text = await page.locator("body").innerText().catch(() => htmlToText(body));
    return {
      status: response?.status() ?? 200,
      body,
      text
    };
  } finally {
    await browser.close();
  }
}

async function fetchPage(
  method: VehicleValuesFetchMethod,
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  execFileImpl: ExecFileLike,
  browserFetchImpl: BrowserFetchLike
) {
  switch (method) {
    case "disabled":
      throw new VehicleValueFetchError("Vehicle Values fetching is disabled in provider settings.", false);
    case "node_fetch":
      return fetchPageWithNodeFetch(url, headers, fetchImpl);
    case "curl":
      return fetchPageWithCurl(url, headers, execFileImpl);
    case "wget":
      return fetchPageWithWget(url, headers, execFileImpl);
    case "browser":
      return browserFetchImpl(url);
  }
}

async function fetchEstimate(
  url: string,
  payload: UpsertVehicleValueConnectionPayload,
  config: FetchableSourceConfig,
  fetchImpl: typeof fetch,
  execFileImpl: ExecFileLike,
  browserFetchImpl: BrowserFetchLike,
  fetchMethod: VehicleValuesFetchMethod
) {
  const validatedUrl = config.validateUrl(url);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchPage(fetchMethod, validatedUrl, config.headers, fetchImpl, execFileImpl, browserFetchImpl);
      if (response.status < 200 || response.status >= 300) {
        throw new VehicleValueFetchError(
          `${sourceLabel(config.source)} vehicle page fetch failed with status ${response.status}.`,
          isRetryableStatus(response.status)
        );
      }
      return {
        url: validatedUrl,
        estimate: config.parseEstimate(response, payload)
      };
    } catch (error) {
      const retryable =
        error instanceof VehicleValueFetchError
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

function getFetchMethodForSource(
  settings: VehicleValuesProviderSettingsDto,
  sourceKey: FetchableSourceConfig["key"]
): VehicleValuesFetchMethod {
  switch (sourceKey) {
    case "kbb":
      return settings.kbbFetchMethod;
    case "hagerty":
      return settings.hagertyFetchMethod;
  }
}

async function resolveSourceStates({
  payload,
  existingDetails,
  mode,
  fetchImpl,
  execFileImpl,
  browserFetchImpl,
  fetchMethods,
  now
}: {
  payload: UpsertVehicleValueConnectionPayload;
  existingDetails?: VehicleValueConnectionDetailsDto | null;
  mode: FetchMode;
  fetchImpl: typeof fetch;
  execFileImpl: ExecFileLike;
  browserFetchImpl: BrowserFetchLike;
  fetchMethods: VehicleValuesProviderSettingsDto;
  now: Date;
}) {
  const timestamp = toTimestamp(now);
  const nowMs = now.getTime();
  const sourceStates = buildSourceStates(payload, existingDetails, timestamp);

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

    try {
      const fetched = await fetchEstimate(
        state.url,
        payload,
        config,
        fetchImpl,
        execFileImpl,
        browserFetchImpl,
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

export type VehicleValuesService = ProviderAdapter & {
  createConnection(payload: UpsertVehicleValueConnectionPayload): Promise<ProviderConnectResult>;
  updateConnection(connectionId: string, payload: UpsertVehicleValueConnectionPayload): Promise<ProviderConnectResult>;
};

export function createVehicleValuesService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  now = () => new Date(),
  fetchImpl = fetch,
  execFileImpl = promisify(execFile),
  browserFetchImpl = fetchPageWithBrowser
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  execFileImpl?: ExecFileLike;
  browserFetchImpl?: BrowserFetchLike;
} = {}): VehicleValuesService {
  const getEffectiveSettings = async () => {
    const settings = await providerSettings.getAll();
    return (
      settings.VEHICLE_VALUES ?? {
        automaticSyncConcurrency: 1,
        kbbFetchMethod: "curl" as const,
        hagertyFetchMethod: "browser" as const
      }
    );
  };

  const persistConnectionDetails = async ({
    connectionId,
    label,
    details
  }: {
    connectionId: string;
    label?: string | null;
    details: VehicleValueConnectionDetailsDto;
  }) => {
    const derivedLabel = label?.trim() || buildVehicleLabel(details);
    await database.connection.update({
      where: { id: connectionId },
      data: {
        label: derivedLabel,
        status: "ACTIVE",
        institutionName: "Vehicle Values",
        institutionId: "vehicle-values",
        lastRefreshedAt: now(),
        metadataJson: JSON.stringify({
          vehicleValues: details,
          health: clearSyncHealth()
        } satisfies VehicleValuesMetadata),
        accounts: {
          updateMany: {
            where: {},
            data: {
              name: derivedLabel,
              officialName: buildVehicleLabel(details),
              type: "vehicle",
              subtype: "vehicle-value",
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
    mode
  }: {
    payload: UpsertVehicleValueConnectionPayload;
    existingDetails?: VehicleValueConnectionDetailsDto | null;
    mode: FetchMode;
  }) => {
    const effectiveNow = now();
    const effectiveSettings = await getEffectiveSettings();
    const sourceStates =
      mode === "cached"
        ? buildSourceStates(payload, existingDetails, toTimestamp(effectiveNow))
        : await resolveSourceStates(
            stripUndefined({
              payload,
              existingDetails,
              mode,
              fetchImpl,
              execFileImpl,
              browserFetchImpl,
              fetchMethods: effectiveSettings,
              now: effectiveNow
            })
          );
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
    if (connection.provider !== "VEHICLE_VALUES") {
      throw new Error("Connection is not a Vehicle Values connection");
    }

    const metadata = parseConnectionMetadata(connection.metadataJson) as VehicleValuesMetadata;
    const rawDetails = metadata.vehicleValues;
    if (!rawDetails?.make || !rawDetails.model) {
      throw new Error("Vehicle Values connection is missing make or model details.");
    }

    const payload = fromRawDetails(rawDetails);
    const details = await resolveDetails({
      payload,
      existingDetails: rawDetails,
      mode
    });
    return {
      metadata,
      details
    };
  };

  return {
    provider: "VEHICLE_VALUES",
    isConfigured() {
      return true;
    },

    async createConnection(payload) {
      await getEffectiveSettings();
      const normalizedPayload = normalizeVehicleValuesPayload(payload);
      validateVehicleValuePayload(normalizedPayload);
      const details = await resolveDetails({
        payload: normalizedPayload,
        mode: "force"
      });
      const label = normalizedPayload.label?.trim() || buildVehicleLabel(details);

      const connection = await database.connection.create({
        data: {
          provider: "VEHICLE_VALUES",
          label,
          status: "ACTIVE",
          institutionName: "Vehicle Values",
          institutionId: "vehicle-values",
          accessTokenCiphertext: encryptString("manual-vehicle-values"),
          providerItemId: randomUUID(),
          lastRefreshedAt: now(),
          metadataJson: JSON.stringify({
            vehicleValues: details,
            health: clearSyncHealth()
          } satisfies VehicleValuesMetadata),
          accounts: {
            create: {
              externalAccountId: randomUUID(),
              name: label,
              officialName: buildVehicleLabel(details),
              type: "vehicle",
              subtype: "vehicle-value",
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
      const existingMetadata = parseConnectionMetadata(existing.metadataJson) as VehicleValuesMetadata;
      const normalizedPayload = normalizeVehicleValuesPayload(payload);
      validateVehicleValuePayload(normalizedPayload);
      const details = await resolveDetails({
        payload: normalizedPayload,
        existingDetails: existingMetadata.vehicleValues ?? null,
        mode: "force"
      });
      await persistConnectionDetails(
        stripUndefined({
          connectionId,
          label: payload.label,
          details
        })
      );
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
        const metadata = parseConnectionMetadata(connection.metadataJson) as VehicleValuesMetadata;
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
            } satisfies VehicleValuesMetadata)
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
        imported: 0,
        transactions: [],
        balanceSnapshot: {
          asOfDate: now().toISOString().slice(0, 10),
          currentValue: details.calculatedValue ?? 0,
          stableId: `vehicle-value:${link.connectionAccount.externalAccountId}`,
          payeeName: "Vehicle Value Adjustment",
          importedPayee: buildVehicleLabel(details),
          notes: buildVehicleValuesNotes(details),
          searchText: [
            details.vin ?? undefined,
            details.make,
            details.model,
            details.trim ?? undefined,
            details.zipCode,
            details.kbbUrl || undefined,
            details.hagertyUrl || undefined,
            sourceLabel(details.source)
          ].filter((value): value is string => Boolean(value))
        },
        removedImportedIds: []
      });
    }
  };
}

export const vehicleValuesService = createVehicleValuesService();
