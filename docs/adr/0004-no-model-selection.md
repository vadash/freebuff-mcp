---
status: accepted (2026-09-27)
---

# ADR-0004: No model selection — the first message starts the session on the remembered model

- **Supersedes:** ADR-0001 §6 (the hardcoded model pick) and §3's "the Instance
  idles at the Model picker" idle design.

## Context

A freebuff CLI update removed the Model picker. The CLI now opens on the
**Welcome screen**: logo, an account info box ("Your first message starts the
session.", `25/25 Freebucks remaining`), and the ready input box. The Hour
session starts with the first submitted message, and it runs on the model the
CLI remembers — the status line shows it (`DeepSeek V4.1 Flash · high · … ·
/model to change`). `/model` still exists in the CLI, but there is no model
list at startup and no reason for the supervisor to touch it.

The Pick rule existed to choose a model at the picker (first affordable
deepseek, else glm, else mimo, else top row). With no picker, it has nothing
to act on. ADR-0001 §6 called the rule "hardcoded for v1 and easy to reverse".

## Decision

- The supervisor never selects a model and never sends `/model`. The Instance
  runs whatever model freebuff remembers; `status.activeModel` keeps reporting
  what the status line shows.
- The Model picker recognition, the Pick rule, and the picker row/price
  parsing are deleted. The supervisor supports only the current CLI; an old
  CLI surfaces as `screenDrift` through `doctor`.
- The no-session idle state is `idle` at the Welcome screen. A Task submitted
  there is the first message: it starts the Hour session. The supervisor still
  never ends a session early and still presses Continue only when a Task
  arrives.

## Consequences

- Model choice — and its Freebucks price — is out of our hands. The balance
  parse stays only as `status` information; no decision gates on it.
- The Fallback Enter risk case is gone: Enter on an unrecognized Welcome-area
  screen lands in an empty input box, which starts nothing.
- Freebucks-per-model pricing knowledge is dropped from the glossary until the
  new UI shows a cost the protocol could act on (it cannot act on one anyway).
