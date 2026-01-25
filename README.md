# Oh My OpenCode Dashboard

Local-only, read-only dashboard for viewing OhMyOpenCode agent progress.

## Goals

- Show plan progress from `.sisyphus/boulder.json` + the active plan markdown.
- Show a best-effort view of background tasks from persisted OpenCode session artifacts.
- Never render prompts, tool arguments, or raw tool outputs.

## Requirements

- Bun

## Install (npm)

Run without installing globally:

```bash
bunx -p oh-my-opencode-dashboard oh-my-opencode-dashboard -- --project /absolute/path/to/your/project
```

Or install globally:

```bash
bun add -g oh-my-opencode-dashboard
```

Then:

```bash
oh-my-opencode-dashboard --project /absolute/path/to/your/project
```

Options:

- `--project <path>` (required): project root that contains `.sisyphus/`
- `--port <number>` (optional): default 51234

## Install (from source)

```bash
bun install
```

## Run

Development (API + UI dev server):

```bash
bun run dev -- --project /absolute/path/to/your/project
```

Production (single server serving UI + API):

```bash
bun run build
bun run start -- --project /absolute/path/to/your/project
```

## What It Reads (File-Based)

- Project:
  - `.sisyphus/boulder.json`
  - Plan file at `boulder.active_plan`
- OpenCode storage:
  - `${XDG_DATA_HOME ?? ~/.local/share}/opencode/storage/{session,message,part}`

## Privacy / Redaction

This dashboard is designed to avoid sensitive data:

- It does not display prompts.
- It does not display tool arguments (`state.input`).
- It does not display raw tool output or errors (`state.output`, `state.error`).
- Background tasks extract an allowlist only (e.g., `description`, `subagent_type` / `category`) and derive counts/timestamps.

## Security

- Server binds to `127.0.0.1` only.
- Path access is allowlisted and realpath-based to prevent symlink escape:
  - project root
  - OpenCode storage root

## Limitations

- Background task status is best-effort inference from persisted artifacts.
- If OpenCode storage directories are missing or not readable, sections may show empty/unknown states.

## Troubleshooting

- If the dashboard shows "Disconnected" in dev, make sure the API server is running and the UI is using the Vite proxy.
- If plan progress stays empty, verify your target project has `.sisyphus/boulder.json`.
- If sessions are not detected, verify OpenCode storage exists under `${XDG_DATA_HOME ?? ~/.local/share}/opencode/storage`.
