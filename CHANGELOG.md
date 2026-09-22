# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Raised the `@earendil-works/pi-*` development dependencies to 0.87.0. The advisor runtime drives a bare `Agent`, not an `AgentSession`, so 0.87's SessionManager-canonical change does not affect it and no behavior changed.

## [2.0.0] - 2026-09-11

Forked as **pi-xt-advisors**. Breaking package, config, and command changes.
Historical behavior below the fold is from upstream `pi-omplike-advisor` 1.0.2.

### Changed

- Package renamed from `pi-omplike-advisor` to `pi-xt-advisors`.
- Extension entry is `src/index.ts`; Pi loads TypeScript directly (no build).
- Config moved into Pi `settings.json` under the top-level `"advisor"` key
  (user: `<agentDir>/settings.json`, project: `<cwd>/.pi/settings.json`).
  `PI_CODING_AGENT_DIR` is honored through Pi's `getAgentDir()`. Project
  settings remain trust-gated.
- `/advisor on` and `/advisor off` persist `advisor.review` instead of
  `.advisor-state.json`. Optional `project` argument writes project scope.
- Advisor model is `advisor.model` in `provider/model[:thinkingLevel]` form
  (default `openrouter/z-ai/glm-5.2:low`). `modes.json` `modes.advisor` is
  no longer read.
- Unresolved models are reported as unavailable instead of silently using
  the primary session model.
- Streaming uses the resolved provider and request auth, not API-key-only
  defaults.

### Added

- `advisor.debug`, `advisor.compact.pct` (50–95, default 80), `advisor.review`
  (default true), `advisor.tools`, and `advisor.instructions`.
- `/advisor config` TUI editor with user/project scope and inherit/override
  per field.
- `/advisor monitor` live transcript overlay (does not abort either agent).
- Persistent advisor session at `<session-dir>/advisor/<session>.jsonl`,
  restored on resume/reload. Ephemeral primary sessions stay ephemeral.
  Sidecars are not listed by Pi's session picker.
- `ADVISOR_SYSTEM.md` and `ADVISOR_APPEND_SYSTEM.md` (user and trusted
  project), mirroring Pi's `SYSTEM.md` / `APPEND_SYSTEM.md`.
- `/advisor status` shows session path and prompt-file provenance.

### Removed

- `ADVISOR_DEBUG`, `ADVISOR_COMPACT_AT`, and `ADVISOR_NO_REVIEW`.
- `~/.pi/agent/.advisor-state.json`.
- `~/.pi/agent/system-prompts/advisor.md` as an active override. Use
  `ADVISOR_SYSTEM.md` for wholesale replacement or `advisor.instructions`
  / `ADVISOR_APPEND_SYSTEM.md` to append.
- `modes.json` advisor model entry.

Copy previous values into `settings.json` yourself; legacy files and env
vars are not migrated or deleted.

## [1.0.2] - 2026-07-06

Last `pi-omplike-advisor` release this fork is based on.
