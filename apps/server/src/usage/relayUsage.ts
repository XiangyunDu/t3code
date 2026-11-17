// @effect-diagnostics nodeBuiltinImport:off - reads the Codex home; this leaf must not widen the
// usage service's environment just to look at two files.
// @effect-diagnostics globalFetch:off - one plain GET to the relay's usage endpoint, wrapped in a
// timeout and swallowed on failure.
// @effect-diagnostics globalDate:off - cache freshness is plain wall-clock milliseconds.
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { UsageRelayDay, UsageRelayModel, UsageRelaySummary } from "@t3tools/contracts";

/** The relay accounts in its own currency; a short TTL keeps the page from hammering it. */
const CACHE_TTL_MS = 60_000;
/** A missing or unreachable endpoint stays quiet longer than a successful read. */
const FAILURE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

let cache: { readonly at: number; readonly value: UsageRelaySummary | null } | undefined;

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured && configured.length > 0
    ? NodePath.resolve(configured.replace(/^~(?=$|\/)/, NodeOS.homedir()))
    : NodePath.join(NodeOS.homedir(), ".codex");
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `model_providers.<name>.base_url` for the provider `model_provider` points at. */
function parseProviderBaseUrl(toml: string): string | null {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1].trim();
      sections.set(current, "");
      continue;
    }
    if (current !== undefined) sections.set(current, `${sections.get(current) ?? ""}${line}\n`);
  }

  const baseUrlOf = (name: string): string | null => {
    const body = sections.get(`model_providers.${name}`);
    if (body === undefined) return null;
    const match = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(body);
    return match?.[1] ?? null;
  };

  const active = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (active !== undefined) {
    const direct = baseUrlOf(active);
    if (direct !== null) return direct;
  }
  for (const section of sections.keys()) {
    const prefix = "model_providers.";
    if (!section.startsWith(prefix)) continue;
    const candidate = baseUrlOf(section.slice(prefix.length));
    if (candidate !== null) return candidate;
  }
  return null;
}

interface RelayTarget {
  readonly usageUrl: string;
  readonly apiKey: string;
}

async function resolveTarget(): Promise<RelayTarget | null> {
  const overrideUrl = process.env.T3_RELAY_USAGE_URL?.trim();
  const overrideKey = process.env.T3_RELAY_USAGE_KEY?.trim();

  let baseUrl = overrideUrl !== undefined && overrideUrl.length > 0 ? overrideUrl : null;
  if (baseUrl === null) {
    const config = await readTextFile(NodePath.join(codexHome(), "config.toml"));
    baseUrl = config === null ? null : parseProviderBaseUrl(config);
  }
  if (baseUrl === null) return null;

  let apiKey = overrideKey !== undefined && overrideKey.length > 0 ? overrideKey : null;
  if (apiKey === null) {
    const auth = await readTextFile(NodePath.join(codexHome(), "auth.json"));
    if (auth !== null) {
      try {
        const parsed: unknown = JSON.parse(auth);
        if (typeof parsed === "object" && parsed !== null) {
          const value = (parsed as Record<string, unknown>)["OPENAI_API_KEY"];
          if (typeof value === "string") apiKey = value;
        }
      } catch {
        apiKey = null;
      }
    }
  }
  if (apiKey === null) return null;

  const normalized = baseUrl.replace(/\/+$/, "");
  return {
    usageUrl: normalized.endsWith("/v1/usage") ? normalized : `${normalized}/v1/usage`,
    apiKey,
  };
}

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

function mapDay(raw: unknown): UsageRelayDay | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const day = string(record["date"]);
  if (day === null) return null;
  return {
    day,
    requests: Math.max(0, Math.round(number(record["requests"]))),
    inputTokens: Math.max(0, Math.round(number(record["input_tokens"]))),
    outputTokens: Math.max(0, Math.round(number(record["output_tokens"]))),
    cacheReadTokens: Math.max(0, Math.round(number(record["cache_read_tokens"]))),
    cacheWriteTokens: Math.max(0, Math.round(number(record["cache_write_tokens"]))),
    totalTokens: Math.max(0, Math.round(number(record["total_tokens"]))),
    // `actual_cost` is what the relay calls the real spend; `cost` is its quota-charged figure.
    costUsd: number(record["actual_cost"]) || number(record["cost"]),
  };
}

function mapModel(raw: unknown): UsageRelayModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const model = string(record["model"]);
  if (model === null) return null;
  return {
    model,
    requests: Math.max(0, Math.round(number(record["requests"]))),
    totalTokens: Math.max(0, Math.round(number(record["total_tokens"]))),
    costUsd: number(record["actual_cost"]) || number(record["cost"]),
  };
}

const EMPTY_DAY: UsageRelayDay = {
  day: "1970-01-01",
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

function mapPayload(payload: unknown, endpoint: string): UsageRelaySummary | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const subscription =
    typeof root["subscription"] === "object" && root["subscription"] !== null
      ? (root["subscription"] as Record<string, unknown>)
      : {};
  const usage =
    typeof root["usage"] === "object" && root["usage"] !== null
      ? (root["usage"] as Record<string, unknown>)
      : {};
  const todayRaw = usage["today"];
  const today = mapDay(
    typeof todayRaw === "object" && todayRaw !== null
      ? { ...(todayRaw as Record<string, unknown>), date: "today" }
      : null,
  );

  const days = Array.isArray(root["daily_usage"])
    ? root["daily_usage"]
        .map(mapDay)
        .filter((day): day is UsageRelayDay => day !== null)
        .sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const models = Array.isArray(root["model_stats"])
    ? root["model_stats"]
        .map(mapModel)
        .filter((model): model is UsageRelayModel => model !== null)
        .sort((a, b) => b.costUsd - a.costUsd)
    : [];

  return {
    planName: string(root["planName"]),
    unit: string(root["unit"]) ?? "USD",
    isValid: root["isValid"] !== false,
    mode: string(root["mode"]),
    remainingUsd: optionalNumber(root["remaining"]),
    dailyLimitUsd: optionalNumber(subscription["daily_limit_usd"]),
    dailyUsedUsd: optionalNumber(subscription["daily_usage_usd"]),
    weeklyLimitUsd: optionalNumber(subscription["weekly_limit_usd"]),
    weeklyUsedUsd: optionalNumber(subscription["weekly_usage_usd"]),
    monthlyLimitUsd: optionalNumber(subscription["monthly_limit_usd"]),
    monthlyUsedUsd: optionalNumber(subscription["monthly_usage_usd"]),
    expiresAt: string(subscription["expires_at"]),
    today: today ?? EMPTY_DAY,
    days,
    models,
    fetchedAt: new Date().toISOString(),
    endpoint,
  };
}

async function fetchRelayUsage(target: RelayTarget): Promise<UsageRelaySummary | null> {
  const response = await fetch(target.usageUrl, {
    headers: { Authorization: `Bearer ${target.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return mapPayload(await response.json(), new URL(target.usageUrl).host);
}

async function loadRelayUsage(force: boolean): Promise<UsageRelaySummary | null> {
  const now = Date.now();
  if (!force && cache !== undefined) {
    const ttl = cache.value === null ? FAILURE_TTL_MS : CACHE_TTL_MS;
    if (now - cache.at < ttl) return cache.value;
  }
  try {
    const target = await resolveTarget();
    const value = target === null ? null : await fetchRelayUsage(target);
    cache = { at: now, value };
    return value;
  } catch {
    cache = { at: now, value: null };
    return null;
  }
}

/**
 * Quota and spend from the relay's own usage endpoint, read from the active Codex provider.
 * Never fails the caller: a missing or unreachable endpoint yields null and the page falls back
 * to transcript-derived numbers.
 */
export const readRelayUsage = (force = false): Effect.Effect<UsageRelaySummary | null> =>
  // loadRelayUsage swallows its own failures, so this effect can never fail the summary read.
  Effect.promise(() => loadRelayUsage(force));
