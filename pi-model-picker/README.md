# model-picker

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that changes
model selection: a two-stage picker that sets the model **and** its thinking
level in one flow.

- **Stage 1** — pick a model, with **type-to-filter** matching across
  `provider/id` and display name (e.g. typing `sonnet` finds
  `anthropic/claude-sonnet-4-5`). Fixed-width columns show capability icons,
  id, and context window; the current model is marked and preselected.
- **Stage 2** — pick a reasoning level from the levels the selected model
  actually supports (derived from `reasoning` + `thinkingLevelMap`), with a
  colour-coded intensity gauge. Shows the provider-mapped value for the
  highlighted level. Esc goes **back to stage 1**.

### Row icons

| Icon | Meaning |
|------|---------|
| `≡`  | accepts text |
| `▣`  | accepts images |
| `✦`  | supports extended reasoning |
| `·`  | capability not supported |
| `●`  | currently active model / level |

All glyphs are single-cell (verified with `visibleWidth()`); double-width
glyphs and emoji shear the column alignment and must not be substituted.

### Pricing column

The second column shows `$input/$output` per Mtok, via
[`../lib/pricing.ts`](../README.md#libpricingts):

| Shown | Meaning |
|-------|---------|
| `$3/$15`  | pi's own figure, from the model definition |
| `~$3/$15` | **estimate** from `@pydantic/genai-prices` (public list price) |
| `—`       | no pricing available from either source |

The `~` matters: pi zero-fills `cost` for definitions that omit it (common for
custom/gateway providers in `models.json`), so `{input: 0, output: 0}` means
*unknown*, not *free*. Estimates come from public list prices and ignore
gateway contracts, negotiated rates, and cache/batch pricing — they're for
comparing models at a glance, not for billing.

If no model in the list has any pricing, the column shows the model name
instead of a row of identical placeholders.

Both selections are applied together via `pi.setModel()` + `pi.setThinkingLevel()`
when stage 2 completes.

## Install

One-off test:

```
pi -e /path/to/pi-extensions/pi-model-picker/index.ts
```

For everyday use, see the workspace [README](../README.md#loading-extensions-while-developing)
for how extensions here get symlinked into pi's discovery locations (and why
the `lib` symlink specifically is required, not optional, for this one).

## Usage

Takes over `/model` itself — see `interceptModelCommand` in `index.ts` for
how and why an extension can't just register a command literally named
`model`. No separate `/model-picker` command; there's only one entry point.

```
/model           open the picker
/model sonnet    open the picker with the filter prefilled
```

Stage 1 keys: type to filter · `↑↓` navigate · `Enter` select · `Esc` cancel.
Stage 2 keys: `↑↓` navigate · `Enter` select · `Esc` back to models.

## Notes

- The model list mirrors the session-scoped set (the `--models` CLI flag /
  `enabledModels` setting); with no scoping, all available models are listed.
- If a scoped pattern pinned a thinking level (e.g. `anthropic/*:high`), that
  level is preselected in stage 2.
- Unsupported levels are hidden in stage 2; `pi.setThinkingLevel()` clamps to
  real capabilities regardless (the notification reports the clamp).
- Requires interactive (TUI) mode; the command no-ops elsewhere.

## Implementation notes

Two terminal-rendering hazards this file works around — both cause silent
visual corruption, so read before editing the layout:

1. **`theme.fg()` resets foreground only** (`\x1b[39m`), so a nested colour
   "unpaints" the rest of the line rather than restoring the outer one. Every
   glyph in the primary column is therefore coloured explicitly, and the
   selected row re-asserts accent at the end of the cell group.
2. **`truncateToWidth()` wraps its ellipsis in a FULL reset** (`\x1b[0m`),
   which clears *all* attributes — colour, bold, underline. Embedding it in a
   cell leaves everything after the cut unstyled. Use `fitPlain()` for plain
   cell content before colouring; `truncateToWidth()` is still correct for
   whole lines that already contain ANSI, where the reset lands at end-of-line.

Column widths are measured once across all entries (not per filter pass, which
would make columns jitter while typing) and the primary column is pinned via
`min`/`maxPrimaryColumnWidth` so the description column starts at the same
offset on every row. Descriptions are re-fitted on resize, because a
description wider than the space `SelectList` has left is hard-chopped with no
ellipsis.

Layout helpers (`computeModelColumns`, `composeModelPrimary`,
`composeModelDescription`, `capabilityIcons`, `levelGauge`, `fitPlain`,
`formatCost`) are exported so they can be tested against a real `SelectList`
and `Theme`.
