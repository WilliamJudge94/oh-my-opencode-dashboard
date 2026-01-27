import { describe, it, expect } from "vitest"
import { createApi } from "./api"

describe('API Routes', () => {
  it('should return health check', async () => {
    const api = createApi({
      getSnapshot: () => ({
        mainSession: { agent: "x", currentTool: "-", lastUpdatedLabel: "never", session: "s", statusPill: "idle" },
        planProgress: { name: "p", completed: 0, total: 0, path: "", statusPill: "not started", steps: [] },
        backgroundTasks: [],
        timeSeries: {
          windowMs: 0,
          bucketMs: 0,
          buckets: 0,
          anchorMs: 0,
          serverNowMs: 0,
          series: [{ id: "overall-main", label: "Overall", tone: "muted", values: [] }],
        },
        raw: null,
      }),
    })

    const res = await api.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('should return dashboard data without sensitive keys', async () => {
    const api = createApi({
      getSnapshot: () => ({
        mainSession: { agent: "x", currentTool: "-", lastUpdatedLabel: "never", session: "s", statusPill: "idle" },
        planProgress: { name: "p", completed: 0, total: 0, path: "", statusPill: "not started", steps: [] },
        backgroundTasks: [{ id: "1", description: "d", agent: "a", status: "queued", toolCalls: 0, lastTool: "-", timeline: "" }],
        timeSeries: {
          windowMs: 0,
          bucketMs: 0,
          buckets: 0,
          anchorMs: 0,
          serverNowMs: 0,
          series: [{ id: "overall-main", label: "Overall", tone: "muted", values: [] }],
        },
        raw: { ok: true },
      }),
    })

    const res = await api.request("/dashboard")
    expect(res.status).toBe(200)
    
    const data = await res.json()
    
    expect(data).toHaveProperty("mainSession")
    expect(data).toHaveProperty("planProgress")
    expect(data).toHaveProperty("backgroundTasks")
    expect(data).toHaveProperty("timeSeries")
    expect(data).toHaveProperty("raw")
    
    const sensitiveKeys = ["prompt", "input", "output", "error", "state"]
    
    const checkForSensitiveKeys = (obj: any): boolean => {
      if (typeof obj !== 'object' || obj === null) {
        return false;
      }
      
      for (const key of Object.keys(obj)) {
        if (sensitiveKeys.includes(key)) {
          return true;
        }
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          if (checkForSensitiveKeys(obj[key])) {
            return true;
          }
        }
      }
      return false;
    };
    
    expect(checkForSensitiveKeys(data)).toBe(false)
  })
})
