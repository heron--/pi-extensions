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
│ what shape should the border take?                                              │
│                                                                                 │
╰───────  devin.marsh/context-footer ── #4 ── $0.04 ── ⇡47k ⇣5 ── 󰌿 write unlocked ──╯
```

## Padding

A column of air sits between each rail and the input, and by default a blank
rail row sits above and below it, so the text is not cramped against the frame.
The horizontal gutters are paid for the same way as the rails: the inner editor
renders that much narrower.

```text
/context-footer pad         report the current padding
/context-footer pad full    a blank row above and below the input (default)
/context-footer pad none    no blank row
```

There is no half step, because a terminal row is atomic. Hugging the rule to a
cell edge with `▔`/`▁` would free vertical space without spending a row, but
box-drawing `─` is inked at text height, and that is exactly what lets a status
item read as a break in the line — move the ink to the top of the cell and the
label no longer interrupts the rule, it sits beneath it.

The **top run** carries identity and context health: model, thinking level,
working directory, context gauge and window. The **bottom run** carries the
remaining session items: git branch, its pull request, session cost,
cache-inclusive input/output token totals, and background-task state when
active.

### Pull request

When `gh` reports a pull request for the current branch, its number follows the
branch as an OSC 8 hyperlink — ⌘-click, or whatever the terminal binds. The
lookup runs once per branch, off the render path, and caches misses too, so a
branch without a pull request does not spawn `gh` again. A pull request opened
mid-session therefore appears on the next pi run. If `gh` is missing,
unauthenticated, or slow, the segment is simply absent.

Items are separated by short rule segments, so the border reads as continuous
line broken by labels rather than as a line with a separate status bar attached.
The top run is left-aligned and the bottom run right-aligned, so the long
unbroken stretch of each rule falls on the opposite corner from the other's —
which gives the input more apparent room than packing both runs left. When a
run is wider than the terminal, its content is truncated with `…` and the frame
still closes.

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
pi's bash-mode and thinking-level tinting instead of overriding it. The pull
request number uses the theme's link color and the money figure the theme's
accent color.

Thinking colors match `pi-powerline-footer`: `minimal`, `low`, and `medium` use
pi's corresponding thinking colors; `high`, `xhigh`, and `max` use its exact
purple → pink → yellow → green → cyan → blue gradient. The model marker is the
Nerd Font `nf-md-skull` glyph.

## Cost

For each completed response, the footer uses Pi's reported cost when present.
Otherwise it calls the same bundled `@pydantic/genai-prices` model used by the
model picker, with input, output, cache-read, and cache-write tokens. This
calculation is performed per response so long-context price tiers are applied
correctly. Estimates are not marked apart from exact totals — the whole figure
is understood to be approximate. The money glyph is a dollar sign in its own
right, so the segment is just `$0.04` with no icon in front of it.

Totals cover every billed entry in the session, matching what pi's own
`getUsageCostBreakdown` counts: assistant responses, usage a tool reported for
itself, and the calls behind a compaction or branch summary. It walks the whole
session rather than the active branch, because an abandoned branch was still
billed. Only assistant responses carry a model id, so everything else can
contribute only the cost pi recorded for it.

## Copying out of the prompt

The rails are real characters, so a normal drag across them copies them too —
no terminal offers a way to mark a glyph unselectable. Use rectangular
selection to take just the text: ⌥-drag in iTerm2, Terminal.app, and Ghostty
selects only the columns dragged across.

Drawing the rails as background-tinted spaces instead would copy as whitespace,
but a background fills the whole cell, so the rail becomes a band rather than a
hairline and joins the corners less cleanly. The hairline won out.

## Borrowed statuses

The `pi-background-tasks` status is shown on the bottom run, so its
running/finished-task indicator and its entry keys remain visible instead of
being lost when this extension replaces pi's standard footer. Statuses arrive
pre-styled for pi's own footer — `pi-background-tasks` ships a filled
light-blue pill — so the styling is stripped and repainted in the theme's
accent color, and the item reads as part of the border rather than a sticker on
it. Other global footer summaries, such as the MCP server count, are
intentionally excluded to keep the prompt area quiet.

The `write-lock` status is borrowed too, but not in the accent color: it is
repainted in the theme's warning color — yellow — with a lock icon that
follows the state, `󰌾` for `write locked` and `󰌿` for `write unlocked`
(nf-md-lock and nf-md-lock_open). The label text is whatever write-lock
published, so the lock state stays visible at a glance even without reading it.

## Usage

The extension activates automatically when it is linked into a pi extension
discovery directory.

```text
/context-footer            toggle the decoration
/context-footer on         enable it
/context-footer off        disable it
/context-footer pad none   set the padding (see above)
```

`off` leaves the editor wrapper installed but inert, which avoids removing a
subsequently installed editor integration such as the `/model` interceptor, and
hands the footer back to pi so the session information does not simply vanish.

For the same reason, the footer renders the status as two plain rows whenever
the terminal is too narrow to frame — replacing pi's footer and then declining
to draw is how the model, context and cost disappear entirely.

## Development

```bash
npm run typecheck
pi
```

Run `node scripts/link-extensions.mjs --yes` from the repository root after a
fresh checkout. It adds both the project-local and global symlinks needed to
load this extension.
