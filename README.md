# freebuff-supervisor

Terminal automation layer adapted from Praket7/freebuff-mcp (MIT). Screen
rendering is parsed with @xterm/headless (MIT), the xterm.js core build.

Supervises a CLI coding agent running in a pseudo-terminal: watches the rendered
screen for readiness, queues tasks, and parks sessions. Protocol constants and
the VT screen flattener live in `src/protocol/`; configuration in `src/config.ts`.

## Configure

Requires Node.js 22.6 or newer: the server runs its TypeScript sources directly
(`--experimental-strip-types`), so there is no build step.

```json
{
  "mcpServers": {
    "freebuff-supervisor": {
      "command": "node",
      "args": ["--experimental-strip-types", "<path-to-repo>/src/server.ts"]
    }
  }
}
```

## Operate

- **Login.** Run `freebuff login` once outside the supervisor. When the TUI
  demands a login, tool calls fail with `needs_login`; the supervisor surfaces
  it and never retries automatically.
- **Model policy.** Set `FREEBUFF_MODELS_FILE` to a file with one `org/model`
  slug per line; the first valid line wins. Without it the policy is
  `z-ai/glm-5.3-flash`, then `mimo/mimo-v2.5`, then
  `deepseek/deepseek-v4.1-flash`. The supervisor writes the chosen slug into
  `<configDir>/settings.json` before every spawn. Caveat verified live on CLI
  v0.0.188: the app no longer honors `freebuffModel` preselection and always
  starts its own default (GLM 5.3 Flash). `deepseek/deepseek-v4.1-flash` was
  therefore demoted from the head of the default policy — it could not be
  verified end to end — and the policy file is currently inert against the
  running model until the CLI restores settings-driven selection.
- **Parking.** After every task the supervisor sends `/end-session`, leaving the
  agent parked at the model picker, which is free. The next task resumes the
  parked session.

## Real smoke test

`tests/real-smoke.test.ts` drives a live, signed-in Freebuff CLI and consumes
trial-clock minutes. It is skipped by default; opt in with:

```
FREEBUFF_REAL_SMOKE=1 npx vitest run tests/real-smoke.test.ts
```

## Develop

```
npm install
npm test
npm run typecheck
```
