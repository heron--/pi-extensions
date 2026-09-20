# tool-output

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that puts
tool calls and results in the same house box as the prompt footer, recap, and
user messages.

The default presentation uses:

- a dark `userMessageBg` ground;
- a green `nf-fa-wrench` icon and display-name label in the border, matching
  the footer's git branch color (`success`);
- a bold accent-colored semantic summary above the call arguments;
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
  become descriptors such as `workflowScript: 19 KB · 501 lines`.
- Small arrays/objects stay inline; larger or deeply nested structures become
  item/field counts. The compact view considers at most eight argument fields.
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

Summaries recognize file paths/ranges, searches/scopes, shell commands, background
commands, subagent modes/workflows and declared lanes, MCP targets, parallel tool
names, and other known tool metadata. When a recognized summary contains explicit
`key: value` fields, keys retain summary green while values use `emphasisText`;
plain-language summaries remain green. Shell summaries preserve common chains and
pipelines, respect quoted separators, and replace inline interpreter bodies and
heredoc bodies with script labels. This is a bounded, best-effort display sketch,
**not** a shell parser or a safety check. It never executes scripts or infers
workflow lanes from embedded code.

Unknown opted-in tools and unexpected/partial argument shapes use the generic
compact preview. Existing tool-ownership rules still apply: this does not take
ownership of every installed tool or replace preserved third-party renderers.

Each tool family is summarized by its own exported function in `summaries.ts`
(`summarizeRead`, `summarizeSearch`, `summarizeShell`, `summarizeSubagent`, and
so on), selected by a flat name check in `summarize`. A new tool family is one
summarizer plus one routing line, and each is unit-tested directly in
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
unstyled text, because `Theme.fg` throws on an unknown color name. Chains end in
a stock color, which `colors.test.mjs` enforces.

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
