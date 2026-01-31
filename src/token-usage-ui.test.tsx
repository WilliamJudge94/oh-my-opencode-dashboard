import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenUsageUi, TokenUsage } from "./token-usage-ui";



function mkTokenUsage(override?: Partial<TokenUsage>): TokenUsage {
  return {
    totals: { input: 100, output: 50, reasoning: 25, cacheRead: 10, cacheWrite: 5, total: 190 },
    rows: [
      { model: "anthropic/claude-opus-4-5", input: 60, output: 30, reasoning: 15, cacheRead: 5, cacheWrite: 2, total: 112 },
      { model: "openai/gpt-4", input: 40, output: 20, reasoning: 10, cacheRead: 5, cacheWrite: 3, total: 78 },
    ],
    ...override,
  };
}

describe("TokenUsageUi (SSR)", () => {
  it("should render collapsed state when expanded=false", () => {
    // #given
    const tokenUsage = mkTokenUsage();

    // #when
    const html = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={false} />);

    // #then
    expect(html).toContain("data-testid=\"token-usage-ui\"");
    expect(html).toContain("TOTAL");
    expect(html).not.toContain("anthropic/claude-opus-4-5");
  });

  it("should render expanded state when expanded=true", () => {
    // #given
    const tokenUsage = mkTokenUsage();

    // #when
    const html = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={true} />);

    // #then
    expect(html).toContain("data-testid=\"token-usage-ui\"");
    expect(html).toContain("TOTAL");
    expect(html).toContain("anthropic/claude-opus-4-5");
  });

  it("should handle empty token usage gracefully", () => {
    // #given
    const tokenUsage = mkTokenUsage({ rows: [], totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

    // #when
    const htmlCollapsed = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={false} />);
    const htmlExpanded = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={true} />);

    // #then
    expect(htmlCollapsed).toContain("data-testid=\"token-usage-ui\"");
    expect(htmlExpanded).toContain("data-testid=\"token-usage-ui\"");
    expect(htmlCollapsed).toContain("TOTAL");
    expect(htmlExpanded).toContain("TOTAL");
    expect(htmlCollapsed).not.toContain("No token usage detected yet");
    expect(htmlExpanded).toContain("No token usage detected yet");
  });

  it("should preserve totals display in both expanded and collapsed states", () => {
    // #given
    const tokenUsage = mkTokenUsage();

    // #when
    const htmlCollapsed = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={false} />);
    const htmlExpanded = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={true} />);

    // #then
    expect(htmlCollapsed).toContain("TOTAL");
    expect(htmlExpanded).toContain("TOTAL");
    expect(htmlCollapsed).toContain("100");
    expect(htmlExpanded).toContain("100");
    expect(htmlCollapsed).toContain("50");
    expect(htmlExpanded).toContain("50");
  });

  it("should format token counts with commas", () => {
    // #given
    const tokenUsage = mkTokenUsage({
      totals: { input: 1200, output: 50, reasoning: 25, cacheRead: 10, cacheWrite: 5, total: 1290 },
      rows: [
        { model: "anthropic/claude-opus-4-5", input: 1200, output: 30, reasoning: 15, cacheRead: 5, cacheWrite: 2, total: 1252 },
      ],
    });

    // #when
    const html = renderToStaticMarkup(<TokenUsageUi tokenUsage={tokenUsage} expanded={true} />);

    // #then
    expect(html).toContain("1,200");
  });
});
