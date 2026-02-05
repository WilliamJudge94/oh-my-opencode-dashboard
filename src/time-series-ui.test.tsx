import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TimeSeriesActivitySection,
  SourceSelect,
  buildDashboardUrl,
  resolveSelectedSourceId,
  computeMainAgentsScaleMax,
  computeOtherMainAgentsCount,
} from "./App";

type TimeSeriesProps = React.ComponentProps<typeof TimeSeriesActivitySection>;

function mkTimeSeries(override?: Partial<TimeSeriesProps["timeSeries"]>): TimeSeriesProps["timeSeries"] {
  const buckets = 3;
  const mkSeries = (id: TimeSeriesProps["timeSeries"]["series"][number]["id"], values: number[]) => ({
    id,
    label: id,
    tone: "muted" as const,
    values,
  });

  return {
    windowMs: 300_000,
    buckets,
    bucketMs: 2_000,
    anchorMs: 0,
    serverNowMs: 0,
    series: [
      mkSeries("overall-main", [0, 0, 0]),
      mkSeries("agent:sisyphus", [0, 0, 0]),
      mkSeries("agent:prometheus", [0, 0, 0]),
      mkSeries("agent:atlas", [0, 0, 0]),
      mkSeries("background-total", [0, 0, 0]),
    ],
    ...override,
  };
}

describe("TimeSeriesActivitySection (SSR)", () => {
  it("should not render top axis and should keep bottom axis", () => {
    // #given
    const timeSeries = mkTimeSeries();

    // #when
    const html = renderToStaticMarkup(<TimeSeriesActivitySection timeSeries={timeSeries} />);

    // #then
    expect(html).not.toContain("timeSeriesAxisTop");
    expect(html).toContain("timeSeriesAxisBottom");
  });

  it("should render sand bars for other main agents when derived otherMain is non-zero", () => {
    // #given
    const timeSeries = mkTimeSeries({
      series: [
        { id: "overall-main", label: "Overall", tone: "muted", values: [10, 0, 0] },
        { id: "agent:sisyphus", label: "Sisyphus", tone: "teal", values: [0, 0, 0] },
        { id: "agent:prometheus", label: "Prometheus", tone: "red", values: [0, 0, 0] },
        { id: "agent:atlas", label: "Atlas", tone: "green", values: [0, 0, 0] },
        { id: "background-total", label: "Background", tone: "muted", values: [0, 0, 0] },
      ],
    });

    // #when
    const html = renderToStaticMarkup(<TimeSeriesActivitySection timeSeries={timeSeries} />);

    // #then
    expect(html).toContain("timeSeriesBar--sand");
  });
});

describe("time-series helpers", () => {
  it("computeOtherMainAgentsCount should clamp to >= 0 and ignore invalid numbers", () => {
    // #given
    const value = computeOtherMainAgentsCount({
      overall: 10,
      background: 3,
      sisyphus: 2,
      prometheus: 1,
      atlas: 0,
    });

    // #then
    expect(value).toBe(4);

    expect(
      computeOtherMainAgentsCount({
        overall: NaN,
        background: Infinity,
        sisyphus: -1,
        prometheus: 0,
        atlas: 0,
      })
    ).toBe(0);
  });

  it("computeMainAgentsScaleMax should include otherMain in the max", () => {
    // #given
    const scaleMax = computeMainAgentsScaleMax({
      buckets: 1,
      overallValues: [10],
      backgroundValues: [0],
      sisyphusValues: [0],
      prometheusValues: [0],
      atlasValues: [0],
    });

    // #then
    expect(scaleMax).toBe(10);
  });
});

describe("SourceSelect (SSR)", () => {
  it("should render all source labels in the dropdown", () => {
    // #given
    const sources = [
      { id: "src-a", label: "Work", updatedAt: 1_700_000_000_000 },
      { id: "src-b", label: "Personal", updatedAt: 1_700_000_100_000 },
      { id: "src-c", label: "Sandbox", updatedAt: 1_700_000_200_000 },
    ];

    // #when
    const html = renderToStaticMarkup(
      <SourceSelect
        sources={sources}
        selectedSourceId={"src-b"}
        disabled={false}
        onChange={() => {
          // noop
        }}
      />
    );

    // #then
    expect(html).toContain("Work");
    expect(html).toContain("Personal");
    expect(html).toContain("Sandbox");
  });
});

describe("source selection helpers", () => {
  it("buildDashboardUrl should include ?sourceId= for non-null ids", () => {
    // #given
    const url = buildDashboardUrl("abc-123");

    // #then
    expect(url).toContain("/api/dashboard");
    expect(url).toContain("?sourceId=");
    expect(url).toContain("abc-123");
  });

  it("resolveSelectedSourceId should prefer a valid stored sourceId, else fall back to defaultSourceId", () => {
    // #given
    const sources = [
      { id: "s1", label: "One", updatedAt: 0 },
      { id: "s2", label: "Two", updatedAt: 0 },
    ];

    // #then
    expect(
      resolveSelectedSourceId({
        sources,
        defaultSourceId: "s1",
        storedSourceId: "s2",
      })
    ).toBe("s2");

    expect(
      resolveSelectedSourceId({
        sources,
        defaultSourceId: "s1",
        storedSourceId: "does-not-exist",
      })
    ).toBe("s1");
  });
});
