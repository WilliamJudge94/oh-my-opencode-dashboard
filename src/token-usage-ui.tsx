import * as React from "react";

import { formatTokenCount } from "./format-token-count";

export type TokenUsageRow = {
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type TokenUsageTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type TokenUsage = {
  totals: TokenUsageTotals;
  rows: TokenUsageRow[];
};

export function TokenUsageUi(props: { tokenUsage?: TokenUsage; expanded: boolean }) {
  const { tokenUsage, expanded } = props;
  
  const totals = tokenUsage?.totals || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const rows = tokenUsage?.rows || [];

  return React.createElement("div", { "data-testid": "token-usage-ui" },
    React.createElement("table", { className: "table" },
      React.createElement("tbody", null,
        React.createElement("tr", null,
          React.createElement("td", { className: "mono" }, "TOTAL"),
          React.createElement("td", { className: "mono" }, formatTokenCount(totals.input)),
          React.createElement("td", { className: "mono" }, formatTokenCount(totals.output)),
          React.createElement("td", { className: "mono" }, formatTokenCount(totals.reasoning)),
          React.createElement("td", { className: "mono" }, formatTokenCount(totals.cacheRead)),
          React.createElement("td", { className: "mono" }, formatTokenCount(totals.cacheWrite))
        ),
        expanded && rows.length === 0 ? 
          React.createElement("tr", null,
            React.createElement("td", { colSpan: 6, className: "muted", style: { padding: 16 } },
              "No token usage detected yet."
            )
          ) : null,
        expanded ? rows.map((row) =>
          React.createElement("tr", { key: row.model },
            React.createElement("td", { className: "mono", title: row.model }, row.model),
            React.createElement("td", { className: "mono" }, formatTokenCount(row.input)),
            React.createElement("td", { className: "mono" }, formatTokenCount(row.output)),
            React.createElement("td", { className: "mono" }, formatTokenCount(row.reasoning)),
            React.createElement("td", { className: "mono" }, formatTokenCount(row.cacheRead)),
            React.createElement("td", { className: "mono" }, formatTokenCount(row.cacheWrite))
          )
        ) : null
      )
    )
  );
}
