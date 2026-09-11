# pi-xt-advisors

A persistent **advisor** extension for [pi](https://github.com/badlogic/pi-mono): a second model that reviews the main agent's work each turn and injects concise advice inline.

This is a fork of [pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor).

## Install

Add the package to pi settings (`~/.pi/agent/settings.json`, or `PI_CODING_AGENT_DIR`):

```json
{
  "packages": ["git:github.com/furbyhaxx/pi-xt-advisors"]
}
```

Pi loads TypeScript from `src/index.ts` directly. No build step.

## Commands

| Command | What it does |
|---|---|
| `/advisor` or `/advisor status` | Model, cost, session path, prompt files |
| `/advisor on` / `/advisor off` | Enable or disable review (`advisor.review`) |
| `/advisor config` | Interactive settings editor (user or project scope) |
| `/advisor monitor` | Live advisor transcript overlay |

## Configuration

Settings live under the top-level `advisor` key in pi's `settings.json`. See [docs/configuration.md](docs/configuration.md).

Prompt files `ADVISOR_SYSTEM.md` and `ADVISOR_APPEND_SYSTEM.md` mirror pi's `SYSTEM.md` / `APPEND_SYSTEM.md`. Advisor sessions are stored next to the observed session in an `advisor/` subdirectory. See [docs/usage.md](docs/usage.md).

## Development

See [docs/development.md](docs/development.md).
