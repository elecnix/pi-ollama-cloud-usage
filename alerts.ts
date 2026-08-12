/**
 * Threshold tracking for Ollama Cloud usage notifications.
 *
 * - session (5h) and weekly (7d): notify at every 10% increment (10..100).
 * - extra usage balance: notify only at 80% and 95%.
 *
 * Pure functions: given the previous notified state and current percentages,
 * return the newly-crossed alerts and the updated state. Window resets are
 * detected by a drop below the previously-notified threshold, which re-arms
 * the threshold so a fresh climb notifies again.
 */

export type Metric = "session" | "weekly" | "extra";
export type NotifyLevel = "info" | "warning" | "error";

export interface Alert {
  metric: Metric;
  /** The % threshold that was crossed (10, 20, … 100, or 80/95 for extra). */
  threshold: number;
  /** Current percentage at the time of the alert. */
  pct: number;
  level: NotifyLevel;
}

export interface ThresholdState {
  /** Highest 10% threshold already notified for the session window. */
  session: number;
  /** Highest 10% threshold already notified for the weekly window. */
  weekly: number;
  /** Highest extra-usage threshold already notified (0, 80, or 95). */
  extra: number;
}

const TEN_PCT = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const EXTRA = [80, 95];

export function initialThresholdState(): ThresholdState {
  return { session: 0, weekly: 0, extra: 0 };
}

function levelFor(pct: number, metric: Metric): NotifyLevel {
  if (metric === "extra") return pct >= 95 ? "error" : "warning";
  if (pct >= 90) return "error";
  if (pct >= 80) return "warning";
  return "info";
}

function highestAtOrBelow(p: number, thresholds: number[]): number {
  let best = 0;
  for (const t of thresholds) if (t <= p) best = Math.max(best, t);
  return best;
}

/**
 * Seed state to the current floor WITHOUT emitting alerts.
 * Used on first-ever run (no persisted state) so a session that starts with
 * usage already high does not spam a decade of historical thresholds.
 */
export function seedState(pcts: { session: number; weekly: number; extra: number | null }): ThresholdState {
  return {
    session: highestAtOrBelow(pcts.session, TEN_PCT),
    weekly: highestAtOrBelow(pcts.weekly, TEN_PCT),
    extra: pcts.extra != null ? highestAtOrBelow(pcts.extra, EXTRA) : 0,
  };
}

export function computeAlerts(
  state: ThresholdState,
  pcts: { session: number; weekly: number; extra: number | null },
): { alerts: Alert[]; state: ThresholdState } {
  const next: ThresholdState = { ...state };
  const alerts: Alert[] = [];

  const handle = (metric: Metric, pct: number, already: number, thresholds: number[]) => {
    // Window reset: usage dropped below the last-notified threshold. Re-arm
    // from zero so the next climb notifies again.
    const base = pct < already ? 0 : already;
    const crossed = thresholds.filter((t) => t > base && pct >= t);
    for (const t of crossed) {
      alerts.push({ metric, threshold: t, pct, level: levelFor(pct, metric) });
    }
    next[metric] = crossed.length ? crossed[crossed.length - 1] : base;
  };

  handle("session", pcts.session, state.session, TEN_PCT);
  handle("weekly", pcts.weekly, state.weekly, TEN_PCT);
  if (pcts.extra != null) handle("extra", pcts.extra, state.extra, EXTRA);
  else next.extra = state.extra;

  return { alerts, state: next };
}
