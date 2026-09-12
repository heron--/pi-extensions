# tool-output

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that puts
tool calls and results in the same house box as the prompt footer, recap, and
user messages.

The default presentation uses:

- a dark `userMessageBg` ground;
- a green `nf-fa-wrench` icon and display-name label in the border, matching
  the footer's git branch color (`success`);
- the call arguments as the first content line, in the same branch green;
- dimmed result text, with errors kept red and truncation notices visible;
- an 8-line collapsed preview for read, search, MCP, and known custom tools;
- up to 10 collapsed lines for bash output.

Press Pi's `app.tools.expand` binding—Ctrl+O by default—to expand or collapse
all tool results. The hint follows any user keybinding override rather than
hard-coding the key label.

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
renderers are preserved by default; `decorateMcpToolOutput()` intentionally
hands them over. Exact tool names can be configured without changing the
consumer:

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
