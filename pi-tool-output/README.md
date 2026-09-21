# tool-output

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that puts
tool calls and results in the same house box as the prompt footer, recap, and
user messages.

The default presentation uses:

- a dark `userMessageBg` ground;
- a green `nf-fa-wrench` icon and display-name label in the border, matching
  the footer's git branch color (`success`);
- a bold semantic summary of each call — the path and range, search pattern and
  scope, shell command sketch, subagent mode and declared lanes, or MCP target;
- bounded accent-key / emphasized-value argument previews instead of walls of scripts or JSON;
- dimmed result text, with errors kept red and truncation notices visible;
- an 8-line collapsed preview for read, search, MCP, and known custom tools;
- up to 10 collapsed lines for bash output.

Press Pi's `app.tools.expand` binding—Ctrl+O by default—to expand or collapse
both call arguments and results, including pending calls. The hint follows any
user keybinding override rather than hard-coding the key label.

### Compact calls

All calls owned by this extension use the same bounded argument renderer:

- Short values (up to 160 characters) stay inline. Multiline or longer strings
  become descriptors such as `workflowScript: 19 KB · 501 lines`, whose
  magnitudes and units are tinted apart from the value — see
  [Descriptor tinting](#descriptor-tinting).
- Small arrays/objects stay inline; larger or deeply nested structures become
  item/field counts. The compact view considers at most eight argument fields.
- A field a summary stands in for — a sketched `command`, a labeled
  `workflowScript`, `mcpScript`'s `code` — never returns to the compact preview
  as its original value. When it is long or multi-line it still surfaces as a
  size descriptor; Ctrl+O reveals the original in full.
- The call body has at most one summary row, three wrapped argument rows, and
  one expansion hint. Limits apply **after wrapping**, including narrow terminals.
- Argument keys use the theme's `accent` color (the `identity` teal in the
  bundled `frontier-funds` theme) and values use `emphasisText` (falling back
  to `accent`); separators and expansion hints remain subdued. Every color is
  named in `colors.ts` — see [Colors](#colors). Ctrl+O reveals the
  original arguments with multiline string layout preserved.
  Expansion is still bounded to 16,000 characters and 120 wrapped argument rows,
  with bounded tree depth/node traversal and an explicit cap notice. These call
  limits are independent of `expandedPreviewMaxLines`, which controls results.
- Compaction is presentation-only: execution inputs, saved calls, and model
  context are unchanged. Full inputs remain in the session transcript.

Unknown opted-in tools and unexpected/partial argument shapes use the generic
compact preview. Existing tool-ownership rules still apply: this does not take
ownership of every installed tool or replace preserved third-party renderers.

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

When a summary contains explicit `key: value` fields, keys keep the summary
color while values use `summaryValue`; plain-language summaries are drawn in one
color. See [Colors](#colors).

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

`colors.ts` holds every color this extension paints; no other module names a
theme color. `TOOL_OUTPUT_COLORS` groups them by the region they paint — `box`
(frame and label), `call` (summary and argument rows), and `result` (output,
errors, notices, metadata) — so retuning one region leaves the others alone.

Values are theme color names rather than hex codes, so the active theme resolves
them and the palette follows theme switches. A color the stock themes do not
define is written as a fallback chain in preference order, such as
`["emphasisText", "accent"]`: `paint` tries each candidate and falls back to
unstyled text, because `Theme.fg` throws on an unknown color name. Every chain
ends in a color Pi's stock theme defines, which `colors.test.mjs` enforces by
reading that theme from the live install rather than a retyped list.

### Descriptor tinting

A generated descriptor is not a plain value, so its parts are colored
separately. `command: 288 B · 1 line` renders as four distinct tones:

| Part | Palette entry | Stock theme |
|---|---|---|
| `command` | `argumentKey` | `accent` |
| `288`, `1` | `valueMeasure` | `syntaxNumber` |
| `B`, `line` | `valueUnit` | `syntaxType` |
| the inner ` · ` | `valueSeparator` | `dim` |

### Expanded multi-line values

Expanding a call with a multi-line value — a script, a prompt, a nested tree —
keeps **every** line in the call's tone (`argumentBody`), not just the first, so
an expanded command stays visually distinct from the dimmed result below it.

Which lines continue a value is reported by `expandedArguments` as `fieldLines`,
the indices of lines that begin a top-level field. The renderer parses `key:`
structure only on those lines. Field boundaries are therefore positional facts
from the generator, so a body line that happens to read `limit: 99` stays body
text instead of being repainted as a field.

The `·` inside a descriptor is part of one value, not a field boundary, so it is
tinted apart from the ` · ` that separates `key: value` pairs. The same treatment
applies to `array · 10000 items` and `object · 100+ fields`.

Generated stand-in labels — `[circular]`, `[large value]`, `<inline script>`,
`<long argument>` — use `valuePlaceholder` to read as metadata rather than as
content. They are listed in `ARGUMENT_PLACEHOLDERS`, which is both what writes
them and what recognizes them, so a literal value that merely looks like one (a
`[abc]` character class, `--flag=[x]`) keeps the ordinary value color.

`argumentSpans` performs the split and returns typed spans
(`measure`, `unit`, `separator`, `placeholder`, `text`); the renderer only maps
span kinds to colors. Spans always rebuild the original string exactly, which
`arguments.test.mjs` asserts.

The richer `edit`/`write` diff renderer is deliberately not reimplemented here.
Their ownership flags default to `false`, leaving those tools to
`pi-tool-display` until a separate diff renderer is sourced. Setting either flag
to `true` opts into Pi's built-in renderer as an escape hatch.

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
  "registerToolOverrides": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": false,
    "write": false
  },
  "customToolOverrides": {},
  "readOutputMode": "preview",
  "searchOutputMode": "preview",
  "mcpOutputMode": "preview",
  "previewLines": 8,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 10
}
```

`readOutputMode`, `searchOutputMode`, and `mcpOutputMode` accept `hidden`,
`summary`, or `preview`. `bashOutputMode` accepts `opencode`, `summary`, or
`preview`. Expanded output remains available in `summary` and `preview` modes;
`hidden` intentionally suppresses it. Ownership and mode edits take effect
after `/reload`.

### Coexisting with `pi-tool-display`

Pi rejects duplicate tool names, so the old renderer must release the five tools
this extension owns while it remains installed. Its
`<agent-dir>/extensions/pi-tool-display/config.json` should contain:

```json
{
  "registerToolOverrides": {
    "read": false,
    "grep": false,
    "find": false,
    "ls": false,
    "bash": false,
    "edit": true,
    "write": true
  }
}
```

That is the current local migration state: `pi-tool-output` owns compact and
hidden rows; `pi-tool-display` owns only the unsourced diff renderers.

## Decorator API

Extension tools can opt into the same rendering without depending on load
order:

```ts
// Sibling extension in this checkout. The shared discovery directories link
// pi-tool-output alongside the consumer, so this path works there too.
import { decorateMcpToolOutput, decorateToolOutput } from "../pi-tool-output/decorate.ts";

pi.registerTool(decorateMcpToolOutput(mcpTool));
pi.registerTool(decorateToolOutput(noisyTool, { kind: "generic", outputMode: "summary" }));
```

Installed package consumers can use the exported
`pi-tool-output/decorate` subpath instead. When `pi-tool-output` has not loaded
yet, the helper queues the tool object and
the renderer decorates it in place when its API becomes available. Existing
renderers are preserved as a set by default: if either call or result rendering
already exists, neither is changed. `decorateMcpToolOutput()` intentionally
hands the full renderer set over. Exact tool names can be configured without
changing the consumer:

```json
{
  "customToolOverrides": {
    "ide_find_symbol": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    },
    "custom_mcp_gateway": {
      "enabled": true,
      "kind": "mcp",
      "outputMode": "preview"
    }
  }
}
```

Configured overrides take ownership of existing renderers. A `false` shorthand
disables decoration for that exact name; `true` enables generic summary mode.

Known runtime tool names are mapped to readable labels—for example `read` →
`Read File`, `grep` → `Search Files`, `web_search` → `Web Search`, and
`multi_tool_use.parallel` → `Parallel Tools`. MCP namespace names such as
`mcp__atlassian` become `Atlassian`; unknown opted-in tools fall back to their
registered label or title-cased name.

Pi exposes metadata, not executable definitions, through `pi.getAllTools()`.
For installed adapters that cannot import the decorator, TUI sessions therefore
use a narrow late-render fallback: the extension wraps the exported
`ToolExecutionComponent` renderer-selection methods, recognizes MCP definitions
by name/label/description plus the explicit known-tool display-name map, and
swaps only their presentation. The patch restores all three methods on shutdown
and leaves unknown non-MCP tools untouched. An exact custom override also
selects a late-registered tool by name; set its `enabled` to `false` to opt an
auto-detected MCP or known tool out.

The decorator remains the preferred definition-level integration for
first-party tools: it also works before the TUI exists, avoids recognition
heuristics, and preserves load-order independence.

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
```

The PTY check uses scratch settings, inert tool definitions, and synthetic
sessions (no model calls), presses Ctrl+O, and checks decoded screens at 100,
40, and 26 columns. It saves
collapsed/expanded/re-collapsed screens and ANSI captures to a printed temp path.

For a live, synthetic transcript that loads only this checkout's extensions and
shows a long enough tool result to exercise Ctrl+O:

```bash
node scripts/preview-extensions.mjs
```

For a minimal tool-output-only session, disable ambient extensions so
`pi-tool-display` cannot claim the same built-ins:

```bash
pi --no-extensions -e ./pi-tool-output/index.ts
```
