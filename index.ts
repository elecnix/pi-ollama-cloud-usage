/**
 * pi-ollama-cloud-usage — live Ollama Cloud usage in the pi footer + threshold
 * notifications, using only the API key (no browser cookies).
 *
 * - Footer (TUI only, when `ollama-cloud` is the active provider — or always,
 *   via config): `5h ▕███████░░▏ 65%  7d ▕████████░░▏ 94%  [$ ▕██░░░░░░░░▏ 30%]`
 * - Notifications (TUI + RPC, never a tool call, never enters LLM context):
 *   session & weekly at every 10% increment; extra-usage balance at 80% & 95%.
 *
 * Install: `pi install git:github.com/elecnix/pi-ollama-cloud-usage`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Alert, computeAlerts, initialThresholdState, seedState, type ThresholdState } from "./alerts.ts";
import { barColor, renderBar } from "./bar.ts";
import { registerFooterWidget, type RegisteredWidget } from "pi-footer-widget";
import { fetchUsage, readApiKey, type UsageData } from "./usage.ts";

const OLLAMA_PROVIDER = "ollama-cloud";
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 30_000;
const STATE_FILE = join(process.env.HOME || "", ".pi/agent/cache/ollama-cloud-usage-state.json");

interface Config {
  /** Render the footer even when ollama-cloud is not the active provider. */
  alwaysShowFooter: boolean;
  /** Refresh interval in milliseconds (clamped to >= 30s). */
  intervalMs: number;
  /** Use the legacy setFooter() footer replacement instead of the composer/line-3 path. */
  legacyFooter: boolean;
}

interface ResolvedState {
  state: ThresholdState;
  existed: boolean;
}

function readConfig(): Config {
  const cfg: Config = { alwaysShowFooter: false, intervalMs: DEFAULT_INTERVAL_MS, legacyFooter: false };
  const paths = [
    join(process.env.HOME || "", ".pi/agent/ollama-cloud-usage.json"),
    join(process.cwd(), ".pi/ollama-cloud-usage.json"),
  ];
  for (const p of paths) {
    try {
      const o = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
      if (typeof o.alwaysShowFooter === "boolean") cfg.alwaysShowFooter = o.alwaysShowFooter;
      if (typeof o.intervalMs === "number") cfg.intervalMs = o.intervalMs;
      if (typeof o.legacyFooter === "boolean") cfg.legacyFooter = o.legacyFooter;
    } catch {
      /* ignore */
    }
  }
  if (cfg.intervalMs < MIN_INTERVAL_MS) cfg.intervalMs = MIN_INTERVAL_MS;
  return cfg;
}

function readState(): ResolvedState {
  try {
    const o = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<ThresholdState>;
    return {
      state: { session: o.session ?? 0, weekly: o.weekly ?? 0, extra: o.extra ?? 0 },
      existed: true,
    };
  } catch {
    return { state: initialThresholdState(), existed: false };
  }
}

function writeState(s: ThresholdState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function fmt(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
  const cfg = readConfig();

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastUsage: UsageData | null = null;
  let thresh: ThresholdState = initialThresholdState();
  let stateExisted = false;
  let seeded = false;
  let active = false;
  let lastCtx: ExtensionContext | null = null;
  let renderReq: { requestRender: () => void } | null = null;
  let widgetReg: RegisteredWidget | null = null;

  // Generic ANSI colors for the composer path. The bridge strips these on the
  // stock footer (line 3) and passes them through on pi-statusbar /
  // pi-powerline-footer. When those composers expose their theme fg (see
  // kreeger/pi-statusbar#2, nicobailon/pi-powerline-footer#176), this can
  // switch to theme-aware coloring.
  const ANSI = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    accent: "\x1b[36m",
    reset: "\x1b[0m",
  } as const;
  function ansiFor(pct: number): string {
    if (pct >= 90) return ANSI.red;
    if (pct >= 80) return ANSI.yellow;
    if (pct >= 50) return ANSI.accent;
    return ANSI.green;
  }

  function notifyAlerts(alerts: Alert[], ctx: ExtensionContext) {
    for (const a of alerts) {
      const label = a.metric === "session" ? "session (5h)" : a.metric === "weekly" ? "weekly (7d)" : "extra usage";
      // ctx.ui.notify works in TUI and RPC mode; it does NOT trigger a tool
      // call and does NOT enter LLM context. In print/json mode it is a no-op.
      ctx.ui.notify(`Ollama Cloud ${label} reached ${a.threshold}% (now ${Math.round(a.pct)}%)`, a.level);
    }
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    const key = readApiKey();
    if (!key) return;
    try {
      const data = await fetchUsage(key);
      lastUsage = data;

      // First-ever run: seed to the current floor silently so a session that
      // starts with usage already high does not spam historical thresholds.
      if (!seeded && !stateExisted) {
        thresh = seedState({
          session: data.sessionPct,
          weekly: data.weeklyPct,
          extra: data.extraPct,
        });
        writeState(thresh);
        seeded = true;
        renderReq?.requestRender();
        pushWidget(ctx);
        return;
      }
      seeded = true;

      const { alerts, state } = computeAlerts(thresh, {
        session: data.sessionPct,
        weekly: data.weeklyPct,
        extra: data.extraPct,
      });
      thresh = state;
      if (alerts.length) {
        writeState(thresh);
        notifyAlerts(alerts, ctx);
      }
      renderReq?.requestRender();
      pushWidget(ctx);
    } catch {
      /* unreadable this cycle; the next tick retries */
    }
  }

  function usageLine(theme: Theme): string {
    if (!lastUsage) return theme.fg("dim", "ollama-cloud usage …");
    const s = theme.fg(barColor(lastUsage.sessionPct), renderBar("5h", lastUsage.sessionPct));
    const w = theme.fg(barColor(lastUsage.weeklyPct), renderBar("7d", lastUsage.weeklyPct));
    let line = `${s}  ${w}`;
    if (lastUsage.extraPct != null) {
      line += `  ${theme.fg(barColor(lastUsage.extraPct), renderBar("$", lastUsage.extraPct))}`;
    }
    return line;
  }

  /** Composer/line-3 string with per-threshold ANSI color (self-colorized). */
  function usageLineColored(): string {
    if (!lastUsage) return "";
    const s = `${ansiFor(lastUsage.sessionPct)}${renderBar("5h", lastUsage.sessionPct)}${ANSI.reset}`;
    const w = `${ansiFor(lastUsage.weeklyPct)}${renderBar("7d", lastUsage.weeklyPct)}${ANSI.reset}`;
    let line = `${s}  ${w}`;
    if (lastUsage.extraPct != null) {
      line += `  ${ansiFor(lastUsage.extraPct)}${renderBar("$", lastUsage.extraPct)}${ANSI.reset}`;
    }
    return line;
  }

  function startTimer(ctx: ExtensionContext): void {
    if (timer) return;
    void refresh(ctx);
    timer = setInterval(() => void refresh(lastCtx ?? ctx), cfg.intervalMs);
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      renderReq = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => {
          unsub();
          if (renderReq === tui) renderReq = null;
        },
        invalidate() {},
        render(width: number): string[] {
          const cwd = ctx.cwd.replace(process.env.HOME || "~", "~");
          const branch = footerData.getGitBranch();
          const cwdLine = branch ? `${cwd} (${branch})` : cwd;

          let input = 0;
          let output = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage?.input ?? 0;
              output += m.usage?.output ?? 0;
            }
          }

          const cu = ctx.getContextUsage();
          const ctxPct = cu?.percent != null ? `${cu.percent.toFixed(0)}%` : "—";
          const left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} ctx ${ctxPct}`);

          const model = theme.fg("dim", `${ctx.model?.id ?? "no-model"}`);
          const right = `${usageLine(theme)} ${model}`;
          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(cwdLine, width), truncateToWidth(left + pad + right, width)];
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter(undefined);
  }

  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === OLLAMA_PROVIDER;
  }

  function showFooter(ctx: ExtensionContext): boolean {
    return cfg.alwaysShowFooter || isOllamaCloud(ctx);
  }

  /** Register the usage bar as a composer-agnostic footer widget (line-3 fallback). */
  function registerComposerWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    widgetReg?.dispose();
    widgetReg = registerFooterWidget(ctx, {
      id: "ollama-cloud",
      render: (acc) =>
        cfg.alwaysShowFooter || acc.getModel()?.provider === OLLAMA_PROVIDER
          ? usageLineColored()
          : "",
      selfColorize: true,
      layout: { placement: "right", priority: 60, minWidth: 24 },
      refreshMs: cfg.intervalMs,
    });
  }

  /** Re-emit the widget, gated by the same showFooter rule as the legacy path. */
  function pushWidget(ctx: ExtensionContext): void {
    if (!widgetReg) return;
    widgetReg.update(showFooter(ctx) ? usageLineColored() : "");
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    const resolved = readState();
    thresh = resolved.state;
    stateExisted = resolved.existed;
    seeded = false;
    active = true;
    if (cfg.legacyFooter) {
      if (showFooter(ctx)) setFooter(ctx);
    } else {
      registerComposerWidget(ctx);
    }
    startTimer(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    lastCtx = ctx;
    if (cfg.legacyFooter) {
      if (showFooter(ctx)) setFooter(ctx);
      else clearFooter(ctx);
    }
    // composer/line-3 path: render() checks the active provider via accessors,
    // so no re-registration is needed on model switch. Re-emit gated by provider.
    pushWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    lastCtx = ctx;
    if (active) await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    active = false;
    stopTimer();
    widgetReg?.dispose();
    widgetReg = null;
    if (cfg.legacyFooter) clearFooter(ctx);
  });

  pi.registerCommand("ollama-usage", {
    description: "Refresh and show current Ollama Cloud usage",
    handler: async (_args, ctx) => {
      await refresh(ctx);
      if (lastUsage) {
        const extra = lastUsage.extraPct != null ? `, extra ${Math.round(lastUsage.extraPct)}%` : "";
        ctx.ui.notify(
          `Ollama Cloud — session ${Math.round(lastUsage.sessionPct)}%, weekly ${Math.round(
            lastUsage.weeklyPct,
          )}%${extra}`,
          "info",
        );
      } else {
        const key = readApiKey();
        ctx.ui.notify(
          key ? "Ollama Cloud usage endpoint unreadable" : "Ollama Cloud usage: no API key configured",
          "warning",
        );
      }
    },
  });
}
