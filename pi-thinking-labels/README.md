# thinking-labels

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
labels thinking blocks in the transcript:

```text
Thinking: first, restate the constraint…
```

- **Painted with the shared scheme** — `lib/thinking-colors.ts`, by the level
  that produced the turn, so the transcript label, the context-footer badge,
  and the model picker's level rows all speak the same colors. No level (or
  `off`) falls back to the theme's accent; the body keeps `thinkingText`.
- **Presentation only, by contract.** The label is baked into the stored
  thinking text so it survives reloads — and a `context` handler strips it
  (plus every ANSI code it carried) from assistant thinking blocks before
  each LLM call, so it never reaches the model and never accumulates.
- **Events, not patches.** `message_update` labels the streaming payload,
  `message_end` the persisted message, `context` sanitizes. API-aware: only
  transports that emit thinking blocks are labelled (the OpenAI reasoning
  APIs and the anthropic family; other `openai-*` transports are excluded).
- **Idempotent under a double pass.** It replaces `pi-tool-display`'s
  always-on labelling (part 02 of retiring it); while both run, the artifact
  stripper removes whichever label landed first, so exactly one shows.

## Usage

```text
/thinking-labels          report whether labels are on
/thinking-labels on|off   toggle (persisted in the agent config directory)
```

## Development

Same install conventions as its siblings — the symlink script picks it up
by convention (it imports [`../lib/thinking-colors.ts`](../README.md#libthinking-colorsts),
which the existing `lib` link covers). `npm run typecheck` from the repo root.
