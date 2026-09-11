# Configuration

Advisor settings are stored in pi `settings.json` under the top-level `advisor` key.

| File | Scope |
|---|---|
| `join(getAgentDir(), "settings.json")` | User. Honors `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) |
| `join(cwd, ".pi", "settings.json")` | Project, only when the project is trusted |

Project values override user values at each leaf. Comments in examples are documentation only; pi settings are strict JSON.

```json
{
  "advisor": {
    "model": "openrouter/z-ai/glm-5.2:low",
    "debug": false,
    "compact": { "pct": 80 },
    "review": true,
    "tools": ["read", "grep", "find", "ls"],
    "instructions": ""
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `model` | `openrouter/z-ai/glm-5.2:low` | `provider/model` or `provider/model:thinkingLevel` |
| `debug` | `false` | Verbose stderr logging |
| `compact.pct` | `80` | Self-compact when advisor context reaches this percent (50–95) |
| `review` | `true` | Live model review. `/advisor on` and `/off` write this field |
| `tools` | omitted → `read`, `grep`, `find`, `ls` | Replaces the default list. `[]` leaves only the private `advise` tool |
| `instructions` | `""` | Appended last to the advisor system prompt |

The advisor-private `advise` tool is always present. Built-in tools besides the read-only defaults (`bash`, `edit`, `write`, `powershell`) expand the previous read-only contract. Tools from other extensions are listed as unavailable until pi exposes executable handlers.

## Prompt files

Resolved like pi's `SYSTEM.md` / `APPEND_SYSTEM.md`. Trusted project files win over user files independently. Scopes are not concatenated.

| File | Role |
|---|---|
| `ADVISOR_SYSTEM.md` | Replaces the bundled advisor prompt |
| `ADVISOR_APPEND_SYSTEM.md` | Appends to the selected base |
| `WATCHDOG.md` in cwd | Trusted-project extra guidance |

Composition order: selected base → generated modality/WATCHDOG notes → selected append file → `advisor.instructions`.

User files live in `getAgentDir()`. Project files live in `.pi/`.

## Migration from pi-omplike-advisor

| Old | New |
|---|---|
| `modes.json` `modes.advisor` | `advisor.model` (`provider/modelId:thinkingLevel`) |
| `ADVISOR_DEBUG=1` | `advisor.debug` |
| `ADVISOR_COMPACT_AT` | `advisor.compact.pct` |
| `ADVISOR_NO_REVIEW=1` | `advisor.review: false` |
| `.advisor-state.json` `enabled` | `advisor.review` |
| `~/.pi/agent/system-prompts/advisor.md` | `ADVISOR_SYSTEM.md` (wholesale replacement, not `instructions`) |

Legacy files and environment variables are not read.
