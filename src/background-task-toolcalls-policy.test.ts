import { describe, it, expect } from "vitest"
import { computeToolCallsFetchPlan, toggleIdInSet } from "./App"

describe('computeToolCallsFetchPlan', () => {
  it('should not fetch when sessionId is missing', () => {
    // #given: no sessionId
    const params = {
      sessionId: null,
      status: "running",
      cachedState: "idle" as const,
      cachedDataOk: false,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(false)
    expect(result.force).toBe(false)
  })

  it('should not fetch when not expanded', () => {
    // #given: expanded is false
    const params = {
      sessionId: "session-123",
      status: "done",
      cachedState: "idle" as const,
      cachedDataOk: false,
      isExpanded: false
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(false)
    expect(result.force).toBe(false)
  })

  it('should force fetch when status is "running" and expanded', () => {
    // #given: running status
    const params = {
      sessionId: "session-123",
      status: "running",
      cachedState: "ok" as const,
      cachedDataOk: true,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(true)
    expect(result.force).toBe(true)
  })

  it('should not fetch when non-running status and cached data is ok', () => {
    // #given: done status with good cache
    const params = {
      sessionId: "session-123",
      status: "done",
      cachedState: "ok" as const,
      cachedDataOk: true,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(false)
    expect(result.force).toBe(false)
  })

  it('should not fetch when already loading', () => {
    // #given: loading state
    const params = {
      sessionId: "session-123",
      status: "done",
      cachedState: "loading" as const,
      cachedDataOk: false,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(false)
    expect(result.force).toBe(false)
  })

  it('should fetch when non-running, not cached, not loading, and expanded', () => {
    // #given: done status with no cache
    const params = {
      sessionId: "session-123",
      status: "done",
      cachedState: "idle" as const,
      cachedDataOk: false,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(true)
    expect(result.force).toBe(false)
  })

  it('should handle case-insensitive status values', () => {
    // #given: RUNNING in uppercase
    const params = {
      sessionId: "session-123",
      status: "RUNNING",
      cachedState: "idle" as const,
      cachedDataOk: false,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(true)
    expect(result.force).toBe(true)
  })

  it('should handle whitespace in status values', () => {
    // #given: running with whitespace
    const params = {
      sessionId: "session-123",
      status: "  running  ",
      cachedState: "idle" as const,
      cachedDataOk: false,
      isExpanded: true
    }

    // #when
    const result = computeToolCallsFetchPlan(params)

    // #then
    expect(result.shouldFetch).toBe(true)
    expect(result.force).toBe(true)
  })
})

describe('toggleIdInSet', () => {
  it('should add id when not present in set', () => {
    // #given: empty set
    const currentSet = new Set<string>()

    // #when
    const result = toggleIdInSet("task-1", currentSet)

    // #then
    expect(result.has("task-1")).toBe(true)
    expect(result.size).toBe(1)
  })

  it('should remove id when already present in set', () => {
    // #given: set with id already present
    const currentSet = new Set(["task-1", "task-2"])

    // #when
    const result = toggleIdInSet("task-1", currentSet)

    // #then
    expect(result.has("task-1")).toBe(false)
    expect(result.has("task-2")).toBe(true)
    expect(result.size).toBe(1)
  })

  it('should not modify original set', () => {
    // #given: original set
    const originalSet = new Set(["task-1"])

    // #when
    const result = toggleIdInSet("task-2", originalSet)

    // #then
    expect(originalSet.has("task-1")).toBe(true)
    expect(originalSet.has("task-2")).toBe(false)
    expect(originalSet.size).toBe(1)
    expect(result.has("task-1")).toBe(true)
    expect(result.has("task-2")).toBe(true)
    expect(result.size).toBe(2)
  })
})