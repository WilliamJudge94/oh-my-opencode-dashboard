import * as React from "react";
import { computeWaitingDing } from "./ding-policy";
import { playDing, unlockAudio } from "./sound";

const APP_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim().length > 0 ? __APP_VERSION__ : "0.0.0";

const APP_TITLE = `Agent Dashboard (v${APP_VERSION})`;

type BackgroundTask = {
  id: string;
  description: string;
  subline?: string;
  agent: string;
  lastModel: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | string;
  toolCalls: number;
  lastTool: string;
  timeline: string;
};

type TimeSeriesTone = "muted" | "teal" | "red" | "green";

type TimeSeriesSeriesId =
  | "overall-main"
  | "agent:sisyphus"
  | "agent:prometheus"
  | "agent:atlas"
  | "background-total";

type TimeSeriesSeries = {
  id: TimeSeriesSeriesId;
  label: string;
  tone: TimeSeriesTone;
  values: number[];
};

type TimeSeries = {
  windowMs: number;
  buckets: number;
  bucketMs: number;
  anchorMs: number;
  serverNowMs: number;
  series: TimeSeriesSeries[];
};

type DashboardPayload = {
  mainSession: {
    agent: string;
    currentTool: string;
    currentModel: string;
    lastUpdatedLabel: string;
    session: string;
    statusPill: string;
  };
  planProgress: {
    name: string;
    completed: number;
    total: number;
    path: string;
    statusPill: string;
    steps?: Array<{ checked: boolean; text: string }>;
  };
  backgroundTasks: BackgroundTask[];
  timeSeries: TimeSeries;
  raw: unknown;
};

const TIME_SERIES_DEFAULT_WINDOW_MS = 300_000;
const TIME_SERIES_DEFAULT_BUCKET_MS = 2_000;
const TIME_SERIES_DEFAULT_BUCKETS = Math.floor(TIME_SERIES_DEFAULT_WINDOW_MS / TIME_SERIES_DEFAULT_BUCKET_MS);

const TIME_SERIES_SERIES_DEFS: Array<Pick<TimeSeriesSeries, "id" | "label" | "tone">> = [
  { id: "overall-main", label: "Overall", tone: "muted" },
  { id: "agent:sisyphus", label: "Sisyphus", tone: "teal" },
  { id: "agent:prometheus", label: "Prometheus", tone: "red" },
  { id: "agent:atlas", label: "Atlas", tone: "green" },
  { id: "background-total", label: "Background tasks (total)", tone: "muted" },
];

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function toNonNegativeCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function makeZeroTimeSeries(opts: {
  windowMs?: number;
  buckets?: number;
  bucketMs?: number;
  anchorMs?: number;
  serverNowMs?: number;
}): TimeSeries {
  const windowMs = Math.max(1, Math.floor(opts.windowMs ?? TIME_SERIES_DEFAULT_WINDOW_MS));
  const bucketMs = Math.max(1, Math.floor(opts.bucketMs ?? TIME_SERIES_DEFAULT_BUCKET_MS));
  const derivedBuckets = Math.floor(windowMs / bucketMs);
  const buckets = Math.max(
    1,
    Math.floor(opts.buckets ?? (derivedBuckets > 0 ? derivedBuckets : TIME_SERIES_DEFAULT_BUCKETS))
  );
  const serverNowMs = Math.floor(opts.serverNowMs ?? 0);
  const anchorMs = Math.floor(opts.anchorMs ?? 0);

  const values = new Array<number>(buckets).fill(0);
  return {
    windowMs,
    buckets,
    bucketMs,
    anchorMs,
    serverNowMs,
    series: TIME_SERIES_SERIES_DEFS.map((def) => ({ ...def, values: values.slice() })),
  };
}

function normalizeTimeSeries(input: unknown, nowMsFallback: number): TimeSeries {
  if (!input || typeof input !== "object") {
    const bucketMs = TIME_SERIES_DEFAULT_BUCKET_MS;
    const serverNowMs = nowMsFallback;
    const anchorMs = Math.floor(serverNowMs / bucketMs) * bucketMs;
    return makeZeroTimeSeries({
      windowMs: TIME_SERIES_DEFAULT_WINDOW_MS,
      bucketMs,
      buckets: TIME_SERIES_DEFAULT_BUCKETS,
      anchorMs,
      serverNowMs,
    });
  }

  const rec = input as Record<string, unknown>;

  const windowMsRaw = toFiniteNumber(rec.windowMs ?? rec.window_ms);
  const bucketsRaw = toFiniteNumber(rec.buckets);
  const bucketMsRaw = toFiniteNumber(rec.bucketMs ?? rec.bucket_ms);
  const bucketMs = Math.max(1, Math.floor(bucketMsRaw ?? TIME_SERIES_DEFAULT_BUCKET_MS));

  const bucketsFromWindow = windowMsRaw && bucketMs ? Math.floor(windowMsRaw / bucketMs) : null;
  const buckets = Math.max(1, Math.floor(bucketsRaw ?? bucketsFromWindow ?? TIME_SERIES_DEFAULT_BUCKETS));

  const windowMs = Math.max(1, Math.floor(windowMsRaw ?? buckets * bucketMs));

  const serverNowRaw = toFiniteNumber(rec.serverNowMs ?? rec.server_now_ms);
  const serverNowMs = Math.floor(serverNowRaw ?? nowMsFallback);

  const anchorRaw = toFiniteNumber(rec.anchorMs ?? rec.anchor_ms);
  const anchorMs = Math.floor(anchorRaw ?? Math.floor(serverNowMs / bucketMs) * bucketMs);

  const seriesInput = rec.series;
  const byId = new Map<string, unknown>();
  if (Array.isArray(seriesInput)) {
    for (const s of seriesInput) {
      if (!s || typeof s !== "object") continue;
      const srec = s as Record<string, unknown>;
      const id = typeof srec.id === "string" ? srec.id : typeof srec.key === "string" ? srec.key : null;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, srec);
    }
  }

  const series: TimeSeriesSeries[] = TIME_SERIES_SERIES_DEFS.map((def) => {
    const found = byId.get(def.id);
    const valuesRaw = found && typeof found === "object" ? (found as Record<string, unknown>).values : null;
    const parsed = Array.isArray(valuesRaw) ? valuesRaw.map(toNonNegativeCount) : [];
    const trimmed = parsed.length > buckets ? parsed.slice(parsed.length - buckets) : parsed;
    const padded = trimmed.length < buckets ? trimmed.concat(new Array<number>(buckets - trimmed.length).fill(0)) : trimmed;
    return { ...def, values: padded };
  });

  return { windowMs, buckets, bucketMs, anchorMs, serverNowMs, series };
}

const FALLBACK_DATA: DashboardPayload = {
  mainSession: {
    agent: "sisyphus",
    currentTool: "dashboard_start",
    currentModel: "anthropic/claude-opus-4-5",
    lastUpdatedLabel: "just now",
    session: "qa-session",
    statusPill: "busy",
  },
  planProgress: {
    name: "agent-dashboard",
    completed: 4,
    total: 7,
    path: "/tmp/agent-dashboard.md",
    statusPill: "in progress",
  },
  backgroundTasks: [
    {
      id: "task-1",
      description: "Explore: find HTTP/SSE patterns",
      subline: "task-1",
      agent: "explore",
      lastModel: "opencode/gpt-5-nano",
      status: "running",
      toolCalls: 3,
      lastTool: "grep",
      timeline: "2026-01-01T00:00:00Z: 2m",
    },
  ],
  timeSeries: makeZeroTimeSeries({
    windowMs: TIME_SERIES_DEFAULT_WINDOW_MS,
    bucketMs: TIME_SERIES_DEFAULT_BUCKET_MS,
    buckets: TIME_SERIES_DEFAULT_BUCKETS,
    anchorMs: 0,
    serverNowMs: 0,
  }),
  raw: {
    ok: false,
    hint: "API not reachable yet. Using placeholder data.",
  },
};

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatTime(ts: number | null): string {
  if (!ts) return "never";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function statusTone(status: string): "teal" | "sand" | "red" {
  const s = status.toLowerCase();
  if (s.includes("error") || s.includes("fail")) return "red";
  if (s.includes("run") || s.includes("progress") || s.includes("busy") || s.includes("think")) return "teal";
  return "sand";
}

function maxCount(values: number[]): number {
  let max = 0;
  for (const v of values) {
    if (typeof v !== "number") continue;
    if (!Number.isFinite(v)) continue;
    if (v > max) max = v;
  }
  return max;
}

function barHeight(value: number, max: number, chartHeight: number): number {
  if (!max || value <= 0) return 0;
  return Math.max(1, Math.round((value / max) * chartHeight));
}

async function safeFetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const t = window.setTimeout(() => controller.abort(), 1600);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    window.clearTimeout(t);
  }
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDashboardPayload(json: unknown): DashboardPayload {
  if (!json || typeof json !== "object") {
    return { ...FALLBACK_DATA, raw: json };
  }

  const anyJson = json as Record<string, unknown>;

  const main = (anyJson.mainSession ?? anyJson.main_session ?? {}) as Record<string, unknown>;
  const plan = (anyJson.planProgress ?? anyJson.plan_progress ?? {}) as Record<string, unknown>;
  const tasks = (anyJson.backgroundTasks ?? anyJson.background_tasks ?? []) as unknown;

  const backgroundTasks: BackgroundTask[] = Array.isArray(tasks)
    ? tasks.map((t, idx) => {
        const rec = (t ?? {}) as Record<string, unknown>;
        return {
          id: String(rec.id ?? rec.taskId ?? rec.task_id ?? `task-${idx + 1}`),
          description: String(rec.description ?? rec.name ?? "(no description)"),
          subline:
            typeof rec.subline === "string"
              ? rec.subline
              : typeof rec.taskId === "string"
                ? rec.taskId
                : undefined,
          agent: String(rec.agent ?? rec.worker ?? "unknown"),
          lastModel: toNonEmptyString(rec.lastModel ?? rec.last_model) ?? "-",
          status: String(rec.status ?? "queued"),
          toolCalls: Number(rec.toolCalls ?? rec.tool_calls ?? 0) || 0,
          lastTool: String(rec.lastTool ?? rec.last_tool ?? "-") || "-",
          timeline: String(rec.timeline ?? "") || "",
        };
      })
    : FALLBACK_DATA.backgroundTasks;

  const completed = Number(plan.completed ?? plan.done ?? 0) || 0;
  const total = Number(plan.total ?? plan.count ?? 0) || 0;

  const timeSeries = normalizeTimeSeries(anyJson.timeSeries, Date.now());

  return {
    mainSession: {
      agent: String(main.agent ?? FALLBACK_DATA.mainSession.agent),
      currentTool: String(main.currentTool ?? main.current_tool ?? FALLBACK_DATA.mainSession.currentTool),
      currentModel: toNonEmptyString(main.currentModel ?? main.current_model) ?? "-",
      lastUpdatedLabel: String(main.lastUpdatedLabel ?? main.last_updated ?? "just now"),
      session: String(main.session ?? main.session_id ?? FALLBACK_DATA.mainSession.session),
      statusPill: String(main.statusPill ?? main.status ?? FALLBACK_DATA.mainSession.statusPill),
    },
    planProgress: {
      name: String(plan.name ?? FALLBACK_DATA.planProgress.name),
      completed: total ? Math.min(completed, total) : completed,
      total,
      path: String(plan.path ?? FALLBACK_DATA.planProgress.path),
      statusPill: String(plan.statusPill ?? plan.status ?? FALLBACK_DATA.planProgress.statusPill),
    },
    backgroundTasks,
    timeSeries,
    raw: json,
  };
}

export default function App() {
  const [connected, setConnected] = React.useState(false);
  const [data, setData] = React.useState<DashboardPayload>(FALLBACK_DATA);
  const [lastUpdate, setLastUpdate] = React.useState<number | null>(null);
  const [copyState, setCopyState] = React.useState<"idle" | "ok" | "err">("idle");
  const [soundEnabled, setSoundEnabled] = React.useState(false);
  const [soundUnlocked, setSoundUnlocked] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [errorHint, setErrorHint] = React.useState<string | null>(null);

  const timerRef = React.useRef<number | null>(null);
  const hadSuccessRef = React.useRef(false);
  const soundEnabledRef = React.useRef(false);
  const prevWaitingRef = React.useRef<boolean | null>(null);
  const lastLeftWaitingAtRef = React.useRef<number | null>(null);
  const prevPlanCompletedRef = React.useRef<number | null>(null);
  const prevPlanTotalRef = React.useRef<number | null>(null);

  const servedFrom = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = APP_TITLE;
  }, []);

  React.useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem("omoDashboardSoundEnabled");
      if (raw === "1") {
        setSoundEnabled(true);
      }
    } catch {
      // ignore
    }
  }, []);

  async function enableSound(next: boolean) {
    if (!next) {
      setSoundEnabled(false);
      setSoundUnlocked(false);
      try {
        window.localStorage.setItem("omoDashboardSoundEnabled", "0");
      } catch {
        // ignore
      }
      return;
    }

    const ok = await unlockAudio();
    setSoundUnlocked(ok);
    setSoundEnabled(ok);
    try {
      window.localStorage.setItem("omoDashboardSoundEnabled", ok ? "1" : "0");
    } catch {
      // ignore
    }
  }

  const isWaitingForUser = React.useCallback((payload: DashboardPayload): boolean => {
    const status = payload.mainSession.statusPill.toLowerCase();
    const hasSession = payload.mainSession.session !== "(no session)" && payload.mainSession.session !== "";
    const idle = status.includes("idle");
    const noTool = payload.mainSession.currentTool === "-" || payload.mainSession.currentTool === "";
    return hasSession && idle && noTool;
  }, []);

  const maybePlayDings = React.useCallback((prev: DashboardPayload | null, next: DashboardPayload) => {
    if (!soundEnabledRef.current) return;
    if (!hadSuccessRef.current) return;

    const nowMs = Date.now();
    const suppressFastIdleRoundTripMs = 20_000;

    const waiting = isWaitingForUser(next);
    const prevWaiting = prevWaitingRef.current;

    const completed = next.planProgress.completed;
    const total = next.planProgress.total;
    const prevCompleted = prevPlanCompletedRef.current;
    const prevTotal = prevPlanTotalRef.current;

    const wasComplete = typeof prevCompleted === "number" && typeof prevTotal === "number" && prevTotal > 0 && prevCompleted >= prevTotal;
    const isComplete = total > 0 && completed >= total;

    if (!wasComplete && isComplete) {
      void playDing("all");
    } else if (typeof prevCompleted === "number" && typeof prevTotal === "number") {
      const samePlan = total === prevTotal;
      if (samePlan && completed > prevCompleted) {
        void playDing("task");
      }
    }

    const tool = String(next.mainSession.currentTool ?? "").trim().toLowerCase();
    const prevTool = String(prev?.mainSession.currentTool ?? "").trim().toLowerCase();
    if (tool === "question" && prevTool !== "question") {
      void playDing("question");
    }

    const waitingDecision = computeWaitingDing({
      prev: {
        prevWaiting,
        lastLeftWaitingAtMs: lastLeftWaitingAtRef.current,
      },
      waiting,
      nowMs,
      suppressMs: suppressFastIdleRoundTripMs,
    });

    if (waitingDecision.play) {
      void playDing("waiting");
    }

    prevWaitingRef.current = waitingDecision.next.prevWaiting;
    lastLeftWaitingAtRef.current = waitingDecision.next.lastLeftWaitingAtMs;
    prevPlanCompletedRef.current = completed;
    prevPlanTotalRef.current = total;
  }, [isWaitingForUser]);

  const planPercent = React.useMemo(() => {
    if (!data.planProgress.total) return 0;
    return clampPercent((data.planProgress.completed / data.planProgress.total) * 100);
  }, [data.planProgress.completed, data.planProgress.total]);

  const rawJsonText = React.useMemo(() => {
    return JSON.stringify(data.raw, null, 2);
  }, [data.raw]);

  React.useEffect(() => {
    let alive = true;

    async function tick() {
      let nextConnected = false;
        try {
          const json = await safeFetchJson("/api/dashboard");
          if (!alive) return;
          nextConnected = true;
          hadSuccessRef.current = true;
          setConnected(true);
          setErrorHint(null);
          const next = toDashboardPayload(json);
          setData((prev) => {
            maybePlayDings(prev, next);
            return next;
          });
          setLastUpdate(Date.now());
        } catch (err) {
          if (!alive) return;
          nextConnected = false;
          setConnected(false);
        const msg = err instanceof Error ? err.message : "disconnected";
        setErrorHint(msg);
        setData((prev) => {
          if (!hadSuccessRef.current) return FALLBACK_DATA;
          return {
            ...prev,
            raw: {
              ok: false,
              disconnected: true,
              error: msg,
              note: "Showing last known UI values.",
            },
          };
        });
      } finally {
        const delay = nextConnected ? 2200 : 3600;
        timerRef.current = window.setTimeout(tick, delay);
      }
    }

    tick();

    return () => {
      alive = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [maybePlayDings]);

  async function onCopyRawJson() {
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(rawJsonText);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      window.prompt("Copy raw JSON:", rawJsonText);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 1200);
    }
  }

  const liveLabel = connected ? "Live" : "Disconnected";
  const liveTone = connected ? "teal" : "sand";

  const timeSeriesById = React.useMemo(() => {
    const map = new Map<TimeSeriesSeriesId, TimeSeriesSeries>();
    for (const s of data.timeSeries.series) {
      if (s && typeof s.id === "string") {
        map.set(s.id, s);
      }
    }
    return map;
  }, [data.timeSeries.series]);

  const buckets = Math.max(1, data.timeSeries.buckets);
  const bucketMs = Math.max(1, data.timeSeries.bucketMs);
  const viewBox = `0 0 ${buckets} 28`;
  const minuteStep = Math.max(1, Math.round(60_000 / bucketMs));
  const bucketStartMs = data.timeSeries.anchorMs - (buckets - 1) * bucketMs;

  const overallValues = timeSeriesById.get("overall-main")?.values ?? [];

  return (
    <div className="page">
      <div className="container">
        <header className="topbar">
          <div className="brand">
            <div className="brandMark" aria-hidden="true" />
            <div className="brandText">
              <h1>{APP_TITLE}</h1>
              <p>
                Live view (no prompts or tool arguments rendered).
                {!connected && errorHint ? <span className="hint"> - {errorHint}</span> : null}
              </p>
            </div>
          </div>
          <div className="topbarActions">
            <span className={`pill pill-${liveTone}`}>
              <span className="pillDot" aria-hidden="true" />
              {liveLabel}
            </span>
            <button
              className="button"
              type="button"
              onClick={() => void enableSound(!soundEnabled)}
              aria-pressed={soundEnabled}
              title={soundEnabled ? "Disable sound" : "Enable sound"}
            >
              Sound {soundEnabled ? (soundUnlocked ? "On" : "On") : "Off"}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => void playDing("task")}
              title="Play ding"
              aria-label="Play ding sound"
            >
              Ding
            </button>
            <button className="button" type="button" onClick={onCopyRawJson}>
              {copyState === "ok" ? "Copied" : copyState === "err" ? "Copy failed" : "Copy raw JSON"}
            </button>
          </div>
        </header>

        <main className="stack">
          <section className="timeSeries">
            <div className="timeSeriesHeader">
              <h2 className="timeSeriesTitle">Time-series activity</h2>
              <p className="timeSeriesSub">Last 5 minutes</p>
            </div>

            <div className="timeSeriesAxisTop" aria-hidden="true">
              <div />
              <div className="timeSeriesAxisTopLabels">
                <span className="timeSeriesAxisTopLabel">-5m</span>
                <span className="timeSeriesAxisTopLabel">-4m</span>
                <span className="timeSeriesAxisTopLabel">-3m</span>
                <span className="timeSeriesAxisTopLabel">-1m</span>
              </div>
            </div>

            <div className="timeSeriesRows">
              {(
                [
                  {
                    label: "Sisyphus",
                    tone: "teal" as const,
                    overlayId: "agent:sisyphus" as const,
                    baseline: false,
                  },
                  {
                    label: "Prometheus",
                    tone: "red" as const,
                    overlayId: "agent:prometheus" as const,
                    baseline: false,
                  },
                  {
                    label: "Atlas",
                    tone: "green" as const,
                    overlayId: "agent:atlas" as const,
                    baseline: false,
                  },
                  {
                    label: "background tasks (total)",
                    tone: "muted" as const,
                    overlayId: "background-total" as const,
                    baseline: false,
                  },
                ] as const
              ).map((row) => {
                const H = 28;
                const padTop = 2;
                const padBottom = 2;
                const chartHeight = H - padTop - padBottom;
                const baselineY = H - padBottom;
                const barW = 0.85;
                const barInset = (1 - barW) / 2;

                const overlayValues = timeSeriesById.get(row.overlayId)?.values ?? [];
                const baselineMax = row.baseline ? maxCount(overallValues) : 0;
                const overlayMax = maxCount(overlayValues);
                const scaleMax = Math.max(1, row.baseline ? Math.max(baselineMax, overlayMax) : overlayMax || 1);

                return (
                  <div key={row.overlayId} className="timeSeriesRow" data-tone={row.tone}>
                    <div className="timeSeriesRowLabel">{row.label}</div>
                    <div className="timeSeriesSvgWrap">
                      <svg className="timeSeriesSvg" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true">
                        {Array.from({ length: Math.floor(buckets / minuteStep) + 1 }, (_, idx) => {
                          const x = idx * minuteStep;
                          if (x < 0 || x > buckets) return null;
                          return (
                            <line
                              key={`g-${bucketStartMs + x * bucketMs}`}
                              className="timeSeriesGridline"
                              x1={x}
                              x2={x}
                              y1={0}
                              y2={H}
                            />
                          );
                        })}

                        {row.baseline
                          ? overallValues.slice(0, buckets).map((v, i) => {
                              const h = barHeight(v ?? 0, scaleMax, chartHeight);
                              if (!h) return null;
                              const barX = i + barInset;
                              const bucketMsAt = bucketStartMs + i * bucketMs;
                              return (
                                <rect
                                  key={`b-${bucketMsAt}`}
                                  className="timeSeriesBarBaseline"
                                  x={barX}
                                  y={baselineY - h}
                                  width={barW}
                                  height={h}
                                />
                              );
                            })
                          : null}

                        {overlayValues.slice(0, buckets).map((v, i) => {
                          const h = barHeight(v ?? 0, scaleMax, chartHeight);
                          if (!h) return null;
                          const barX = i + barInset;
                          const bucketMsAt = bucketStartMs + i * bucketMs;
                          return (
                            <rect
                              key={`${row.overlayId}-${bucketMsAt}`}
                              className="timeSeriesBar"
                              x={barX}
                              y={baselineY - h}
                              width={barW}
                              height={h}
                            />
                          );
                        })}
                      </svg>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="timeSeriesAxisBottom" aria-hidden="true">
              <div />
              <div className="timeSeriesAxisBottomLabels">
                <span className="timeSeriesAxisBottomLabel">-5m</span>
                <span className="timeSeriesAxisBottomLabel">-4m</span>
                <span className="timeSeriesAxisBottomLabel">-3m</span>
                <span className="timeSeriesAxisBottomLabel">-2m</span>
                <span className="timeSeriesAxisBottomLabel">-1m</span>
                <span className="timeSeriesAxisBottomLabel">Now</span>
              </div>
            </div>
          </section>

          <section className="grid2">
            <article className="card">
              <div className="cardHeader">
                <h2>Main session</h2>
                <span className={`pill pill-${statusTone(data.mainSession.statusPill)}`}>{data.mainSession.statusPill}</span>
              </div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">AGENT</div>
                  <div className="kvVal mono">{data.mainSession.agent}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">CURRENT TOOL</div>
                  <div className="kvVal mono">{data.mainSession.currentTool}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">CURRENT MODEL</div>
                  <div className="kvVal mono">{data.mainSession.currentModel}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">LAST UPDATED</div>
                  <div className="kvVal">{data.mainSession.lastUpdatedLabel}</div>
                </div>
              </div>
              <div className="divider" />
              <div className="kvRow">
                <div className="kvKey">SESSION</div>
                <div className="kvVal mono">{data.mainSession.session}</div>
              </div>
            </article>

            <article className="card">
              <div className="cardHeader">
                <h2>Plan progress</h2>
                <span className={`pill pill-${statusTone(data.planProgress.statusPill)}`}>{data.planProgress.statusPill}</span>
              </div>
              <div className="cardHeader" style={{ marginTop: 8 }}>
                <button
                  className="button"
                  type="button"
                  onClick={() => setPlanOpen((v) => !v)}
                  aria-expanded={planOpen}
                >
                  {planOpen ? "Hide steps" : "Show steps"}
                </button>
              </div>
              <div className="kv">
                <div className="kvRow">
                  <div className="kvKey">NAME</div>
                  <div className="kvVal mono">{data.planProgress.name}</div>
                </div>
                <div className="kvRow">
                  <div className="kvKey">PROGRESS</div>
                  <div className="kvVal">
                    <span className="mono">
                      {data.planProgress.completed}/{data.planProgress.total || "?"}
                    </span>
                    <span className="muted"> - {Math.round(planPercent)}%</span>
                  </div>
                </div>
              </div>
              {planOpen ? (
                <div className="divider" />
              ) : null}
              {planOpen ? (
                <div className="mono" style={{ fontSize: 12, lineHeight: 1.5 }}>
                  {(data.planProgress.steps ?? []).length > 0
                    ? (data.planProgress.steps ?? []).map((s, idx) => (
                        <div key={`${idx}-${s.checked ? "x" : "_"}-${s.text}`}>[{s.checked ? "x" : " "}] {s.text || "(empty)"}</div>
                      ))
                    : "(no steps detected)"}
                </div>
              ) : null}
              <div className="progressWrap">
                <div className="progressTrack">
                  <div className="progressFill" style={{ width: `${planPercent}%` }} />
                </div>
              </div>
              <div className="mono path">{data.planProgress.path}</div>
            </article>
          </section>

          <section className="card">
            <div className="cardHeader">
              <h2>Background tasks</h2>
              <span className="badge">
                {data.backgroundTasks.length}
              </span>
            </div>
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>DESCRIPTION</th>
                    <th>AGENT</th>
                    <th>LAST MODEL</th>
                    <th>STATUS</th>
                    <th>TOOL CALLS</th>
                    <th>LAST TOOL</th>
                    <th>TIMELINE</th>
                  </tr>
                </thead>
                <tbody>
                  {data.backgroundTasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="taskTitle">{t.description}</div>
                        {t.subline ? <div className="taskSub mono">{t.subline}</div> : null}
                      </td>
                      <td className="mono">{t.agent}</td>
                      <td className="mono">{t.lastModel}</td>
                      <td>
                        <span className={`pill pill-${statusTone(t.status)}`}>{t.status}</span>
                      </td>
                      <td className="mono">{t.toolCalls}</td>
                      <td className="mono">{t.lastTool}</td>
                      <td className="mono muted">{t.status.toLowerCase() === "queued" ? "-" : t.timeline || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <details className="details">
            <summary className="detailsSummary">
              <span className="detailsTitle">Raw JSON</span>
              <span className="chev" aria-hidden="true" />
            </summary>
            <div className="detailsBody">
              <pre className="code">
                <code>{rawJsonText}</code>
              </pre>
            </div>
          </details>
        </main>

        <footer className="footer">
          <div className="footerLeft">
            Local-only dashboard. Served from <span className="mono">{servedFrom}</span>
          </div>
          <div className="footerRight">
            Last update: <span className="mono">{formatTime(lastUpdate)}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
