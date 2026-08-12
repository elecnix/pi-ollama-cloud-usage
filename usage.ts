/**
 * Fetch and parse Ollama Cloud usage from `GET https://ollama.com/api/usage`.
 *
 * No browser cookies — just the API key the provider already stores. The
 * endpoint is undocumented (see ollama/ollama#15663, #16448) and returns:
 *
 *   {
 *     "activity": { "cost": "0.00000", "period": {...}, "models": [] },
 *     "limits": {
 *       "session": { "usage": 0.647, "models": [{ "name": ..., "request_count": ... }] },
 *       "weekly":  { "usage": 0.94,  "models": [...] }
 *     }
 *   }
 *
 * `usage` is a 0–1 fraction of the plan cap. Reset timestamps are NOT exposed,
 * and an extra-usage balance field is only present for accounts that purchased
 * one — we probe a few plausible paths defensively.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelCount {
  name: string;
  request_count: number;
}

export interface UsageData {
  /** 0–100 */
  sessionPct: number;
  /** 0–100 */
  weeklyPct: number;
  /** 0–100, or null when no extra-usage balance is reported. */
  extraPct: number | null;
  sessionModels: ModelCount[];
  weeklyModels: ModelCount[];
  fetchedAt: number;
}

export class UsageError extends Error {}

const ENDPOINT = "https://ollama.com/api/usage";

/** Read the Ollama Cloud API key from $OLLAMA_API_KEY or ~/.pi/agent/auth.json. */
export function readApiKey(authJsonPath?: string): string | null {
  const env = process.env.OLLAMA_API_KEY;
  if (env?.trim()) return env.trim();
  const path = authJsonPath ?? join(process.env.HOME || "", ".pi/agent/auth.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const oc = (parsed as Record<string, unknown>)["ollama-cloud"];
      if (oc && typeof oc === "object") {
        const key = (oc as Record<string, unknown>).key;
        if (typeof key === "string" && key.trim()) return key.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Accept a 0–1 fraction OR an already-percent value (0–100). Returns 0–100. */
function fracToPct(v: unknown): number | null {
  const n = asNum(v);
  if (n == null) return null;
  if (n >= 0 && n <= 1) return n * 100;
  if (n > 1 && n <= 100) return n;
  return null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Defensive probe for an extra-usage balance. The public endpoint does not
 * document this field; we check common shapes and treat the value as a 0–1
 * usage fraction of the purchased extra balance.
 */
function pickExtra(root: Record<string, unknown>): number | null {
  const limits = asObj(root.limits);
  const activity = asObj(root.activity);
  const candidates: unknown[] = [
    limits?.extra,
    limits?.overage,
    root.extra,
    root.overage,
    root.balance,
    activity?.balance,
  ];
  for (const c of candidates) {
    const o = asObj(c);
    if (o) {
      const p = fracToPct(o.usage);
      if (p != null) return p;
    }
    const p = fracToPct(c);
    if (p != null) return p;
  }
  return null;
}

function toModels(v: unknown): ModelCount[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (m): m is ModelCount =>
      !!m &&
      typeof m === "object" &&
      typeof (m as ModelCount).name === "string" &&
      typeof (m as ModelCount).request_count === "number",
  );
}

export function parseUsage(json: unknown): UsageData {
  if (!json || typeof json !== "object") throw new UsageError("usage response is not an object");
  const root = json as Record<string, unknown>;
  const limits = asObj(root.limits) ?? {};
  const session = asObj(limits.session) ?? {};
  const weekly = asObj(limits.weekly) ?? {};

  return {
    sessionPct: fracToPct(session.usage) ?? 0,
    weeklyPct: fracToPct(weekly.usage) ?? 0,
    extraPct: pickExtra(root),
    sessionModels: toModels(session.models),
    weeklyModels: toModels(weekly.models),
    fetchedAt: Date.now(),
  };
}

export async function fetchUsage(key: string, signal?: AbortSignal): Promise<UsageData> {
  const res = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw new UsageError(`usage endpoint returned HTTP ${res.status}`);
  return parseUsage(await res.json());
}
