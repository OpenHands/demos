# Vibe Kanban Canvas Extension

This is a compact reference implementation artifact for converting the core
Vibe Manager idea into an Agent Canvas Extension plus cron automation.

It intentionally removes the standalone FastAPI app, SQLite database, nginx,
systemd, and any separate backend service. The extension and automation share
state through JSON files on the active Agent Server filesystem.

## What it demonstrates

- An installable Canvas Extension page at `/extensions/vibe-kanban/board`.
- A Vibe-like Kanban UI rendered inside Agent Canvas.
- Task persistence as JSON files under `~/.openhands/vibe-kanban/`.
- A manager automation scheduled every minute with `* * * * *`.
- LLM-assisted routing through a persistent manager conversation:
  - mark a card done immediately,
  - append to a known conversation,
  - start a new conversation.
- Known conversation tracking by purpose, summary, status, and routed task IDs.
- Follow-up routing to idle/finished conversations without reopening older done
  cards.

## Install-flow demo

1. Run the full local Agent Canvas stack with the automation backend enabled.
2. Open **Customize -> Extensions**.
3. Install this extension from the PR branch:

   ```text
   Source: https://github.com/OpenHands/demos.git
   Ref: add-kanban-demo-extension
   Repository path: agent-canvas/canvas-extensions/vibe-kanban
   ```

   For a checked-out local copy of this repo, install from the backend-local
   path `agent-canvas/canvas-extensions/vibe-kanban`, or use its absolute path
   if the Agent Server resolves relative paths from a different directory.
4. Installation should leave the extension disabled.
5. Enable it and open the **Vibe Kanban** nav item.
6. Submit a task and click **Start manager**.
7. Click **Run now** or wait for the cron automation to run.

## Files

- `canvas-extension.json` — Canvas Extension manifest.
- `extension.js` — self-contained browser ESM. It contains the UI, scoped CSS,
  JSON store client, minimal tar/gzip writer, automation lifecycle controls,
  and embedded manager automation source.
- `automation/main.py` — the manager automation source separately, for reading
  and iteration. The same source is embedded into `extension.js`.
- `build.mjs` — stdlib-only helper that re-embeds `automation/main.py` into
  `extension.js` after automation edits.

## Storage layout

```text
~/.openhands/vibe-kanban/
  index.json
  tasks/
    <task-id>.json
```

`index.json` tracks the automation id, manager conversation id, known worker
conversations, and task-route history. Each task file tracks title/body/status,
manager decision/reason, routed conversation id, result, and error.

## Simplifications versus vibe-manager

This artifact does not include:

- FastAPI routes or SQLite.
- workspace picker / per-workspace boards.
- attachments.
- PR/merge verification.
- budget enforcement.
- manager chat.
- theme picker.
- worker worktrees.

The point is to keep the extension + automation seam easy to study and reuse.

## Automation endpoint assumption

The browser-side **Start manager** flow follows the same raw-bundle approach as
Vibe Manager:

1. Create a small tar archive containing `main.py` and `config.json`.
2. Gzip it in the browser with `CompressionStream`.
3. Upload to `/api/automation/v1/uploads`.
4. Create or re-enable `/api/automation/v1` with entrypoint `python3 main.py`.

If the active automation backend does not expose raw bundle endpoints yet, use
`automation/main.py` as a manual custom-automation source and write the created
automation id into `index.json`.
