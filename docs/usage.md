# Usage

## Review

When `advisor.review` is true, each primary turn is formatted and sent to a second Agent. Advice is queued and delivered according to severity:

- **nit** — low-stakes, flushed at non-terminal turn boundaries, reconfirmed on terminal turns
- **concern** / **blocker** — always held and reconfirmed before delivery

`/advisor on` and `/advisor off` write `advisor.review` to user settings by default (`/advisor on project` for project scope). If a project value masks the user edit, the command reports that instead of claiming the effective state changed.

## Configurator

`/advisor config` (TUI) picks user or trusted project scope, then edits model, review, debug, compact.pct, tools, and instructions. Each field can inherit or override. Save writes only changed leaves. Escape / Cancel discards.

## Monitor

`/advisor monitor` opens a ~95% overlay of the advisor transcript. It does not wait for the primary or advisor to go idle and does not abort either agent. Escape or `q` closes the view.

The overlay shows review inputs, streamed replies/thinking, tool calls/results, advice decisions, and runtime markers. History comes from the advisor session file when one exists.

## Sessions

The advisor does **not** appear in `/resume`. Its JSONL file sits next to the observed session:

```text
<session-dir>/<session>.jsonl
<session-dir>/advisor/<session>.jsonl
```

The path is derived from `ctx.sessionManager.getSessionFile()`, so custom `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, and `settings.sessionDir` are followed automatically.

- Ephemeral primary sessions (`--no-session`) keep an ephemeral advisor.
- `/new`, `/resume`, `/fork`, and `/clone` each get their own sidecar.
- Self-compaction and primary compaction keep historical JSONL; only the active LLM context is reset.
- `/advisor off` stops review but keeps the file. `/advisor monitor` still works.
- Deleting a primary session file does not currently delete its `advisor/` sidecar.

Interrupted in-flight reviews are restored as interrupted: completed messages and checkpoints reload; incomplete tool-call sequences are not replayed.
