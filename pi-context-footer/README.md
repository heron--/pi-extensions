# context-footer

A small [pi](https://github.com/earendil-works/pi-coding-agent) extension that
uses the prompt editor's own top and bottom border rows as a compact, visible
status frame, inspired by [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer).
It does not add a separate widget above the prompt or alter prompt-text rendering.

## Layout

The prompt's **top border** shows four identity and context items:

1. model
2. thinking level
3. working directory
4. context gauge and window

The **bottom border** shows the remaining session items:

1. git branch
2. session cost
3. cache-inclusive input/output token totals
4. background-task state, when active

For each completed response, the footer uses Pi's reported cost when present.
Otherwise it calls the same bundled `@pydantic/genai-prices` model used by the
model picker, with input, output, cache-read, and cache-write tokens. This
calculation is performed per response so long-context price tiers are applied
correctly. The dollar sign comes from the money icon, so the numeric amount is
not redundantly prefixed with a second `$`.

The `pi-background-tasks` status is also shown on the bottom border, so its
running/finished-task indicator remains visible instead of being lost when this
extension replaces pi's standard footer. Other global footer summaries, such as
the MCP server count, are intentionally excluded to keep the prompt area quiet.

Thinking colors match `pi-powerline-footer`: `minimal`, `low`, and `medium` use
pi's corresponding thinking colors; `high`, `xhigh`, and `max` use its exact
purple → pink → yellow → green → cyan → blue gradient. The model marker is the
Nerd Font `nf-md-skull` glyph. Compact Powerline separators, a left rail on
prompt-content rows, and one blank row above and below the editor give the
prompt vertical breathing room while retaining Pi's cursor marker.

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
