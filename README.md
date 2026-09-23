# freebuff-supervisor

Terminal automation layer adapted from Praket7/freebuff-mcp (MIT).

Supervises a CLI coding agent running in a pseudo-terminal: watches the rendered
screen for readiness, queues tasks, and parks sessions. Protocol constants and
the VT screen flattener live in `src/protocol/`; configuration in `src/config.ts`.

## Develop

```
npm install
npm test
npm run typecheck
```
