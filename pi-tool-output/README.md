# tool-output

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that puts
tool calls and results in the same house box as the prompt footer, recap, and
user messages.

Neighbouring calls share one box with one row per call — a Nerd Font icon,
the display name, a semantic summary, and the size of the output rather than
the output itself — on the same ground as the user's messages. Expanding a call shows its full
arguments and output. Pi's `app.tools.expand` binding (Ctrl+O by default)
expands every call, and the hints follow any user keybinding override rather
than hard-coding the key label.

### Grouped calls

Neighbouring tool calls share one house box. The top of the box always reads
`Ran N tools` (`Running N tools` while any call is still going). Each call's
first row is a Nerd Font icon, its display name, the tool's own summary (see
[Call summaries](#call-summaries)), and the size of its output instead of the
output itself. A call with an input — a script, a file body, a prompt: its
largest multi-line or long string argument — measures that first, before a
` · `. An edit, and a write once it has run, shows its changed lines
instead, `+added -removed` in the theme's diff colors:

```text
╭  Ran 4 tools ──────────────────────────────────────────────────────────╮
│  Read File     path: lib/box.ts:10-29  12 lines, 133 B                │
│  Search Files  pattern: /TODO/ · path: src  2 lines, 31 B             │
│  Run Command   python3 - · heredoc script  42 lines, 379 B · 1 line, 2 B │
│  Edit File     path: lib/box.ts  +12 -3                               │
│  MCP Gateway   linear · list_issue_statuses  1 line, 571 B            │
│   alt+o to expand · ctrl+o to expand all                                │
╰─────────────────────────────────────────────────────────────────────────╯
```

Names are padded so the summaries form one column. Icons come from `TOOL_ICONS` in `rendering.ts`; tools without one get
the wrench. Expanding a call shows the arguments its row does not (`timeout:
120`, MCP's `args:`), then its input in full (the script or prompt the row
only measures), a blank row, and its output. An expanded edit or write shows
its diff instead (see [Edits and writes](#edits-and-writes)).

Sizes count raw output lines and bytes, not wrapped rows. A tool whose result
says more than its size leads with that: a trajectory search's `12 matches`, a
schema's `9 tables`, a session's `7 turns over 2 h 46 min`, Datadog's `5 of 57
tools` (`result-summaries.ts`). Any assistant text or thinking between two
calls starts a new box; an empty tool-only assistant turn does not.

Every tool call joins a group: pi's built-in tools, every extension's tools
whatever renderers they bring, and calls to a tool that is no longer installed,
as in a resumed session. A tool whose [`tools`](#per-tool-settings) entry is
`false` keeps its own renderer and ends the run.

Images in a result are counted on its row (`1 image`) and drawn under the box
when the call is expanded. That includes the chart a Datadog visualization
draws, which the datadog tool keeps in its result details rather than its
content.

Expansion is per call:

- **Click a row** to expand or collapse just that call.
- **Alt+O** (`expandLastKey`) expands or collapses just the most recent call. It
  stays expanded when later calls arrive, until it is clicked or Ctrl+O
  collapses everything.
- **Ctrl+O** (Pi's `app.tools.expand`) expands or collapses every call.

Only the most recent call carries the key hint.

Clicks need Pi's fullscreen TUI (the default `tuiMode`); in `regular` mode the
terminal does not report the mouse, and the keys still work.

### Expanded arguments

An expanded call's arguments use one bounded renderer, with the same
descriptors as the call rows' sizes:

- Short values (up to 160 characters) stay inline. Multiline or longer strings
  become descriptors such as `workflowScript: 19 KB · 501 lines`. An expanded
  multi-line value keeps the call's color on every line, so it is not mistaken
  for output.
- Small arrays/objects stay inline; larger or deeply nested structures become
  item/field counts. The compact view considers at most eight argument fields.
- A field a summary stands in for — a sketched `command`, a labeled
  `workflowScript`, `mcpScript`/`codemode`'s `code` — never returns to the compact preview
  as its original value. When it is long or multi-line it still surfaces as a
  size descriptor; Ctrl+O reveals the original in full.
- The call body has at most one summary row, three wrapped argument rows, and
  one expansion hint. Limits apply **after wrapping**, including narrow terminals.
- Ctrl+O reveals the original arguments with multiline string layout preserved.
  Expansion is still bounded to 16,000 characters and 120 wrapped argument rows,
  with bounded tree depth/node traversal and an explicit cap notice. These call
  limits are independent of `expandedPreviewMaxLines`, which controls results.
- Compaction is presentation-only: execution inputs, saved calls, and model
  context are unchanged. Full inputs remain in the session transcript.

Tools without a summarizer and unexpected/partial argument shapes use the
generic compact preview.

### Call summaries

The first row of a recognized call is a semantic summary: the one detail that
identifies the call, drawn bold above the argument preview. A summarized field
is dropped from the preview below it, so nothing is stated twice.

| Tool | Arguments | Summary |
|---|---|---|
| `read` | `path`, `offset`, `limit` | `path: lib/box.ts:10-29` |
| `grep` | `pattern`, `path`, `glob` | `pattern: /TODO/ · path: src · glob: *.ts` |
| `find` | `pattern` | `pattern: *.ts · path: .` |
| `ls` | — | `path: .` |
| `bash` | `command` | `cd /tmp/repo && npm run check` |
| `bg_run` | `name`, `command` | `Check build · npm test` |
| `edit`, `write` | `path` | `path: a.ts` |
| `web_search` | `query`, `intent` | `Pi docs · docs` |
| `subagent` | `agent` | `agent: reviewer` |
| `subagent` | `workflowScript`, `preflight`, `async` | `Scripted workflow · 2 declared lanes: inspect, test · async` |
| `subagent` | `action`, `id` | `status · run-1` |
| `mcp` | `server`, `tool` | `linear · search_issues` |
| `mcpScript` | `code` | `MCP script` |
| `codemode` | `code` | `JavaScript`; executed calls appear below from Pi's live metadata |
| `multi_tool_use.parallel` | `tool_uses` | `2 parallel tools · functions.read, functions.grep` |
| `fusion_*`, `bg_delegate` | `objective` or `name` | `Inspect bug` |
| `bg_result`, `bg_status`, `bg_logs`, `bg_kill` | `taskId` | `task: task-1` |
| `preview_export` | `format`, `path` | `PDF · plan.md` |
| `ask_user_question` | `questions` | `2 questions · Which library?` |

Summaries describe **declared metadata only**. An embedded task, prompt, or
workflow script is labeled, never quoted: `workflowScript` becomes
`Scripted workflow`, and lanes are counted from the explicit `preflight`
manifest rather than inferred from code. Long values are clipped to 160
characters each, and a whole summary to 480.

A tool with no recognized shape gets no summary row and falls back to the
generic compact preview, which is also what partial streaming arguments and
unexpected scalar types produce.

#### Shell sketches

`bash` and `bg_run` summaries are a display sketch of the command — **not** a
shell parser, and not a safety or execution decision. The sketch preserves the
shape of the command while removing what cannot be shown safely or usefully:

| Command | Sketch |
|---|---|
| `git diff --stat \| head -20` | `git diff --stat \| head -20` |
| `printf '%s' 'a;b && c'` | `printf '%s' 'a;b && c'` |
| `CI=1 npm test` | `CI=… npm test` |
| `node -e "console.log(42)"` | `node -e <inline script>` |
| `env -i python -c "…"` | `env -i python -c <inline script>` |
| `env - node --eval="…"` | `env - node --eval=<inline script>` |
| `/usr/bin/env node -e "…"` | `/usr/bin/env node -e <inline script>` |
| `python -c'…'` | `python -c<inline script>` |
| `node --eval="…"` | `node --eval=<inline script>` |
| `python3 - <<'PY'…` | `python3 - · heredoc script` |
| `a && b && c && d` | `a && b && c …` |

Environment **values** are masked, inline interpreter bodies (`-c`/`-e`/`--eval`,
separate, attached like `-c'…'`/`--eval=…`, or shell-quoted) and heredoc
bodies are replaced with labels — including through an `env` wrapper, whose
own options and assignments (`env -i`, `env -`, `env -u NAME`, `env -C DIR`,
`/usr/bin/env`) are skipped when locating the interpreter, and through the
quotes a caller may put around the executable, a flag, or an assignment
(`"node"`, `'-e'`, `'CI=x'` — detection sees through them, display keeps the
original spelling). Quoted separators stay inside their word, and comments
are dropped. A sketched command is consumed: the original never appears
beside its sketch in the compact preview. Bounds: 4,096 characters read,
80 tokens, 3 pipeline segments, 10 tokens per segment, 240 characters out.
An unterminated quote is marked `…` rather than throwing.

#### Codemode

`codemode` uses a **Code Mode** house box. The collapsed call labels the source
`JavaScript` instead of showing orchestration syntax. Ctrl+O reveals the source,
including short one-line scripts, within the normal argument display caps.

Pi streams `details.calls` as the script runs and saves those records with the
result. The result renderer uses them directly rather than guessing execution
from JavaScript syntax:

```text
✓ Run Command · git status --short · 25ms
✓ Read File · path: lib/box.ts:10-29 · 4ms
✗ Read File · path: missing.ts · 2ms
  File not found
Script completed · 0.2s
(script output)
```

- Names and complete JSON argument previews reuse the existing command, path,
  range, search, and MCP summaries. Loops and dynamically constructed arguments
  work because the records describe actual calls, not static call sites.
- Running (`…`), successful (`✓`), failed (`✗`), and cancelled (`⊘`) calls remain
  distinct. Nested failures stay red even when `Promise.allSettled` lets the
  script succeed. Durations and reported classifier costs remain visible.
- The compact view shows the latest `previewLines` calls (eight by default),
  with one clipped row per call and a separate error row where present. Ctrl+O
  shows recorded arguments and errors, bounded to 256 calls and 120 wrapped
  metadata rows. These limits are separate from the script output's preview
  and `expandedPreviewMaxLines` settings.
- Pi caps each recorded argument preview at 200 characters. Incomplete JSON is
  labeled in the compact view, never evaluated or reconstructed; expansion
  shows the recorded fragment. The source remains available separately.
- The native completion/failure header becomes one row. Script output is not
  interpreted as nested results, and a full-output file notice stays visible
  when Pi truncates it. Images remain owned by Pi's image renderer.

Before any calls are recorded, or in sessions without `details.calls`, the box
still shows the compact source label and ordinary script output. This changes
presentation only: it does not execute source, replace codemode's definition,
change tool exposure, or alter saved calls and model context.

Codemode defaults to preview mode independently of `mcpOutputMode`. A
`tools.codemode` entry can change its output mode; setting that entry to
`false` preserves Pi's own renderers.

#### Adding a summarizer

Each tool family has one exported function in `summaries.ts` — `summarizeRead`,
`summarizeSearch`, `summarizeShell`, `summarizeSubagent`, `summarizeMcp`, and so
on — selected by a flat name check in `summarize`. A new family is one function
plus one routing line. A summarizer returns `undefined` when it has nothing
useful to say, which degrades to the generic preview.

The fields a summarizer names in its return value are the ones omitted from the
argument preview, and they are only omitted when the value actually rendered, so
an unexpected type stays visible. Every summarizer is unit-tested directly in
`summaries.test.mjs`.

### Colors

`colors` in the config overrides the color of anything this extension paints,
by role. A value is a theme color name, which follows theme switches, or a
fixed color in any form a pi theme accepts: `#rgb`, `#rrggbb`, `oklch(…)`,
`okhsl(…)`, or a 0–255 index.

```json
{
  "colors": {
    "call": { "argumentValue": "#5ec8f0" },
    "group": { "summaryPlain": "oklch(65% 0.1 150)" }
  }
}
```

The roles, and the theme color each defaults to, are `TOOL_OUTPUT_COLOR_ROLES`
in [`colors.ts`](colors.ts), grouped by what they paint: `box`, `call`,
`nestedCall` (codemode's calls), `result`, `group` (the grouped rows), and
`diff`. A descriptor's parts are colored apart, so `288 B · 1 line` reads as a
measurement: `call.valueMeasure`, `call.valueUnit`, and `call.valueSeparator`.
An invalid entry is reported at startup and keeps its default.

### Edits and writes

An expanded edit or write shows its diff, laid out for the width it has:

- **Side by side** (`split`) once the diff has `diffSplitMinWidth` columns
  (120 by default): old lines on the left and new on the right, each side
  numbered, every removed line facing the line that replaced it.
- **One column** (`unified`) below that: each line numbered where it lives, the
  removed lines before the lines that replace them.
- Without line numbers below 18 columns, and as bare `+added -removed` below 8.

```text
  old                                │   new
▌   1 │ function greet(name) {       │ ▌   1 │ function greet(name, mark) {
    2 │   return "hi " + name;       │     2 │   return "hi " + name;
      │                              │ ▌   3 │   // the mark goes last
```

`diffViewMode` pins a layout; `split` still falls back to one column where two
do not fit. Code takes its file's syntax colors. Changed rows are tinted with
the theme's diff colors over the box's ground, and where a removed line faces
its replacement, the words that changed are tinted more strongly (`DIFF_TINTS`
in `colors.ts`). `diffIndicatorMode` picks what else marks a changed line: a
bar in the gutter (`bars`), a `+`/`-` sign (`classic`), or nothing (`none`).
Long lines wrap at word boundaries, or are cut with an ellipsis when
`diffWordWrap` is off. A diff longer than `expandedPreviewMaxLines` rows is
capped with a notice.

While a call is pending, its change is previewed against the file as it is
now. A `pending edit` applies the edits by pi's own rules (each `oldText`
matches exactly one place, and none overlap); a write previews as `pending
create` or `pending overwrite`. A preview that cannot be worked out says why
instead. Previews read only files inside the working directory, and only up to
1 MB.

Once the call has run, the diff comes from its result. Pi's edit tool records
its own. This extension's write reads the file before replacing it and records
the change, so a reloaded session still shows what an overwrite replaced; a new
file's contents are the call's own arguments, so it records nothing more. A
failed call shows its error.

This applies while this extension draws `edit` and `write` (the default). With
either set to `false` in `tools`, pi's own tool runs in its place, outside the
groups. When another extension draws them, an expanded call keeps that
extension's view.

## Usage

```text
/tool-output             show the effective state
/tool-output on|off      persist the toggle and reload Pi
/tool-output status      show the effective state
```

Configuration lives at `<agent-dir>/pi-tool-output/config.json` (normally
`~/.pi/agent/pi-tool-output/config.json`), not under the extension symlink.
Missing values use these defaults:

```json
{
  "enabled": true,
  "expandLastKey": "alt+o",
  "tools": {},
  "readOutputMode": "preview",
  "searchOutputMode": "preview",
  "mcpOutputMode": "preview",
  "previewLines": 8,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 10,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffWordWrap": true,
  "colors": {}
}
```

`expandLastKey` is any Pi key id and takes effect after `/reload`. The output
modes below shape what an expanded call shows; a collapsed call shows only its
size. `previewLines` and `bashCollapsedLines` sized the collapsed previews of
the old one-box-per-call layout and no longer change anything.

`readOutputMode`, `searchOutputMode`, and `mcpOutputMode` accept `hidden`,
`summary`, or `preview`. `bashOutputMode` accepts `opencode`, `summary`, or
`preview`. Expanded output remains available in `summary` and `preview` modes;
`hidden` intentionally suppresses it. `diffViewMode` accepts `auto`, `split`,
or `unified`, `diffIndicatorMode` accepts `bars`, `classic`, or `none`, and
`diffSplitMinWidth` is at least 51, the narrowest that fits two columns.
`tools`, mode, diff, and [color](#colors) edits take effect after `/reload`.

### Per-tool settings

`tools` maps an exact tool name to how it is drawn. Every tool not listed is
drawn here.

```json
{
  "tools": {
    "bash": false,
    "ask_user_question": { "expanded": "native" },
    "ide_find_symbol": { "outputMode": "summary" }
  }
}
```

- `false` leaves the tool to its own renderer, outside the groups. For a
  built-in tool, it also leaves the tool itself to pi.
- `expanded: "native"` keeps the tool's row in the group but shows its own
  result renderer when the call is expanded, for a tool whose own view is worth
  keeping. Where that renderer draws nothing, the house view is shown.
- `outputMode` (`hidden`, `summary`, or `preview`) sets how an expanded call
  shows its output. It defaults to `mcpOutputMode` for MCP tools and to
  `preview` for the rest. A built-in tool takes its mode from its own setting.

### With another tool renderer installed

Pi rejects two tools of the same name. Another extension that overrides the
built-in tools, such as `pi-tool-display`, must leave the ones this extension
draws (every built-in, by default) to it, or `tools` must set them to `false`.

## How every tool is reached

Pi asks extensions how to draw each call through its tool-renderer resolvers,
which see every tool name, registered or not. This extension answers with the
house renderers for every tool not set to `false`, keeping the rest of the
tool's definition. The built-in tools are registered here instead, so their
execution can record what a write replaced.

Pi has no API for drawing several calls as one, so the group layout replaces
the drawing and click handling of pi's exported `ToolExecutionComponent`. Both
are restored on shutdown, and renderers are swapped only in a TUI session,
while the layout is installed.

Display names come from `TOOL_DISPLAY_NAMES` in `rendering.ts` where a tool's
registered label is missing or unhelpful — `read` → `Read File`,
`multi_tool_use.parallel` → `Parallel Tools` — and MCP namespace names such as
`mcp__atlassian` become `Atlassian`. Any other tool shows its label, or its
name in title case.

## Development

The root check covers the strict typecheck plus renderer/config/lifecycle and
execution fixtures:

```bash
npm run check
```

Tests resolve runtime packages from the same live Pi installation as the
TypeScript mappings (Node 22.15+). For an automated real-TUI check, with `pi` on
PATH and Python's `pyte` installed:

```bash
python3 pi-tool-output/tui.test.py
python3 pi-tool-output/group.tui.test.py
python3 pi-tool-output/diff.tui.test.py
```

`group.tui.test.py` checks the grouped layout at 100, 60, and 40 columns:
one box per run, size lines in place of output, the hint under only the most
recent call, Alt+O, a real SGR mouse click on a row, and a Ctrl+O round trip.
`diff.tui.test.py` checks an edit, a created file, and an overwrite at 80, 130,
and 170 columns: one column below the split width and side by side above it,
removed lines facing their replacements, and the row and word tints.

The PTY check uses scratch settings, inert tool definitions, Pi's built-in
codemode definition, and synthetic sessions (no model calls), presses Ctrl+O,
and checks decoded screens at 100, 40, and 26 columns. The integration fixture
also executes Pi's real codemode sandbox against inert nested tools to verify
live updates and handled failures. The PTY check saves collapsed/expanded/
re-collapsed screens and ANSI captures to a printed temp path.

For a live, synthetic transcript that loads only this checkout's extensions and
shows a long enough tool result to exercise Ctrl+O:

```bash
node scripts/preview-extensions.mjs
```

For a minimal tool-output-only session, disable ambient extensions so no other
extension claims the same built-ins:

```bash
pi --no-extensions -e ./pi-tool-output/index.ts
```
