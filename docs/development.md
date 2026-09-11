# Development

Pi loads `./src/index.ts` directly. There is no compile or `dist/` step.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Runtime code stays Node-compatible. Bun is used for tests, typecheck, and the lockfile.

Offline tests cover advice policy, transcript formatting, runtime compaction/reconfirm, scoped settings, prompt file precedence, model spec parsing, and sidecar session mapping. They use temporary directories only.

Paid/network advisor-model smoke is opt-in and not part of the default suite.
