# context-footer

A small [pi](https://github.com/earendil-works/pi-coding-agent) extension that
draws a continuous border around the prompt editor and sets session status
items into the rule itself, inspired by
[`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer).
It does not add a separate widget above the prompt or alter prompt-text rendering.

## Layout

The frame is one unbroken box — `╭──╮`, vertical rails down both sides, `╰──╯` —
interrupted only where a status item sits in the rule:

```text
╭── 󰚌 Claude Sonnet 5 ── thinking:high ──  pi-extensions ──  ░░░░░░░░ 5%/1.0M ──╮
│                                                                                 │
╰──  devin.marsh/context-footer ──  ~0.009 ── ⇡46k ⇣5 ───────────────────────────╯
```

The **top run** carries identity and context health: model, thinking level,
working directory, context gauge and window. The **bottom run** carries the
remaining session items: git branch, session cost, cache-inclusive input/output
token totals, and background-task state when active.

Items are separated by short rule segments, so the border reads as continuous
line broken by labels rather than as a line with a separate status bar attached.
When a run is wider than the terminal, its content is truncated with `…` and the
frame still closes.

### Cases the frame absorbs

- **Autocomplete.** Pi appends its completion list below the editor's lower
  rule. That rule becomes a `├──┤` divider, the list gets rails, and the status
  run closes the box underneath — so the completion popup renders *inside* the
  frame instead of below a dangling border.
- **A scrolled input.** When the prompt has more lines than fit, pi replaces a
  rule row with a `↑ N more` marker. That marker is folded into the frame as its
  own status item rather than displacing the border.
- **Narrow terminals.** Below 24 columns there is no room for a rule plus a
  label, so the extension steps aside and returns pi's own editor rows untouched.

### Colors

The frame is painted with the editor's *own* border color, so it keeps following
pi's bash-mode and thinking-level tinting instead of overriding it.

Thinking colors match `pi-powerline-footer`: `minimal`, `low`, and `medium` use
pi's corresponding thinking colors; `high`, `xhigh`, and `max` use its exact
purple → pink → yellow → green → cyan → blue gradient. The model marker is the
Nerd Font `nf-md-skull` glyph.

## Cost

For each completed response, the footer uses Pi's reported cost when present.
Otherwise it calls the same bundled `@pydantic/genai-prices` model used by the
model picker, with input, output, cache-read, and cache-write tokens. This
calculation is performed per response so long-context price tiers are applied
correctly. Estimated totals are marked with a leading `~`. The dollar sign comes
from the money icon, so the numeric amount is not redundantly prefixed with a
second `$`.

The `pi-background-tasks` status is also shown on the bottom run, so its
running/finished-task indicator remains visible instead of being lost when this
extension replaces pi's standard footer. Other global footer summaries, such as
the MCP server count, are intentionally excluded to keep the prompt area quiet.

## Usage

The extension activates automatically when it is linked into a pi extension
discovery directory.

```text
/context-footer       toggle the decoration
/context-footer on    enable it
/context-footer off   disable it
```

`off` leaves the editor wrapper installed but inert. This avoids removing a
subsequently installed editor integration such as the `/model` interceptor.

## Development

```bash
npm run typecheck
pi
```

Run `node scripts/link-extensions.mjs --yes` from the repository root after a
fresh checkout. It adds both the project-local and global symlinks needed to
load this extension.
