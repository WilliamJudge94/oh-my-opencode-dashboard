import * as React from "react";
import { playDing, unlockAudio } from "./sound";

type BackgroundTask = {
  id: string;
  description: string;
  subline?: string;
  agent: string;
  status: "queued" | "running" | "done" | "error" | "cancelled" | string;
  toolCalls: number;
  lastTool: string;
  timeline: string;
};

type DashboardPayload = {
  mainSession: {
    agent: string;
    currentTool: string;
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
  };
  backgroundTasks: BackgroundTask[];
  raw: unknown;
};

const FALLBACK_DATA: DashboardPayload = {
  mainSession: {
    agent: "sisyphus",
    currentTool: "dashboard_start",
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
      status: "running",
      toolCalls: 3,
      lastTool: "grep",
      timeline: "Q 2m ago - S 1m ago",
    },
  ],
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
          status: String(rec.status ?? "queued"),
          toolCalls: Number(rec.toolCalls ?? rec.tool_calls ?? 0) || 0,
          lastTool: String(rec.lastTool ?? rec.last_tool ?? "-") || "-",
          timeline: String(rec.timeline ?? "") || "",
        };
      })
    : FALLBACK_DATA.backgroundTasks;

  const completed = Number(plan.completed ?? plan.done ?? 0) || 0;
  const total = Number(plan.total ?? plan.count ?? 0) || 0;

  return {
    mainSession: {
      agent: String(main.agent ?? FALLBACK_DATA.mainSession.agent),
      currentTool: String(main.currentTool ?? main.current_tool ?? FALLBACK_DATA.mainSession.currentTool),
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
  const [errorHint, setErrorHint] = React.useState<string | null>(null);

  const timerRef = React.useRef<number | null>(null);
  const hadSuccessRef = React.useRef(false);
  const soundEnabledRef = React.useRef(false);
  const prevWaitingRef = React.useRef<boolean | null>(null);
  const prevPlanCompletedRef = React.useRef<number | null>(null);
  const prevPlanTotalRef = React.useRef<number | null>(null);

  const servedFrom = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
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

  function isWaitingForUser(payload: DashboardPayload): boolean {
    const status = payload.mainSession.statusPill.toLowerCase();
    const hasSession = payload.mainSession.session !== "(no session)" && payload.mainSession.session !== "";
    const idle = status.includes("idle");
    const noTool = payload.mainSession.currentTool === "-" || payload.mainSession.currentTool === "";
    return hasSession && idle && noTool;
  }

  function maybePlayDings(next: DashboardPayload) {
    if (!soundEnabledRef.current) return;
    if (!hadSuccessRef.current) return;

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

    if (prevWaiting === false && waiting === true) {
      void playDing("waiting");
    }

    prevWaitingRef.current = waiting;
    prevPlanCompletedRef.current = completed;
    prevPlanTotalRef.current = total;
  }

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
        maybePlayDings(next);
        setData(next);
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
  }, []);

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

  return (
    <div className="page">
      <div className="container">
        <header className="topbar">
          <div className="brand">
            <div className="brandMark" aria-hidden="true" />
            <div className="brandText">
              <h1>Agent Dashboard</h1>
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
              <div className="progressWrap" aria-label="progress">
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
              <span className="badge" aria-label="count">
                {data.backgroundTasks.length}
              </span>
            </div>
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>DESCRIPTION</th>
                    <th>AGENT</th>
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
                      <td>
                        <span className={`pill pill-${statusTone(t.status)}`}>{t.status}</span>
                      </td>
                      <td className="mono">{t.toolCalls}</td>
                      <td className="mono">{t.lastTool}</td>
                      <td className="mono muted">{t.timeline || "-"}</td>
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
