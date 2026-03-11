import { describe, expect, it } from "vitest"

import { DEFAULT_HOST, resolveServerHost } from "./host"

describe("resolveServerHost", () => {
  it("uses the default host when no override is provided", () => {
    expect(resolveServerHost({})).toBe(DEFAULT_HOST)
  })

  it("uses the environment host when provided", () => {
    expect(resolveServerHost({ envHost: "localhost" })).toBe("localhost")
  })

  it("prefers the CLI host over the environment host", () => {
    expect(resolveServerHost({ cliHost: "0.0.0.0", envHost: "localhost" })).toBe("0.0.0.0")
  })

  it("ignores empty host values", () => {
    expect(resolveServerHost({ cliHost: "   ", envHost: "" })).toBe(DEFAULT_HOST)
  })
})
