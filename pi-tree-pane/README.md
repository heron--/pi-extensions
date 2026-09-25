# pi-tree-pane

An experimental [pi](https://github.com/earendil-works/pi-coding-agent) extension for the **fullscreen TUI**. `/tree-pane` toggles a two-column transcript: Pi's existing feed (including tool calls, output, and its normal scrolling) on the left, and a separately scrollable conversation on the right. The editor, status, widgets, and footer remain full-width.

## Try it

From a stable repository checkout, `node scripts/link-extensions.mjs` creates both the project-local and global links. Then launch Pi from any directory:

```bash
pi --tui-mode fullscreen
```

Enter `/tree-pane` to enable the split; enter it again to disable it. `/tree-pane on|off|status` is also available. The toggle starts off, so loading the extension does not change the layout until you enable it.

To test a temporary worktree without changing global links, launch it explicitly from that worktree:

```bash
pi --tui-mode fullscreen --no-extensions -e ./pi-tree-pane/index.ts
```

`--no-extensions` isolates the experiment from installed extensions; omit it to test alongside them.

The right pane follows the latest message until you scroll it. Wheel/trackpad scrolling over either pane and dragging the right scrollbar scroll that pane. **Alt+K** / **Alt+J** page the right pane up/down; **Alt+G** returns to its newest message. Pi's normal transcript keys still scroll the left pane. The right pane shows user text (with `[image]` for attachments) and assistant text, with differently colored labels and each message's local date and time (`YYYY-MM-DD HH:mm`) beside its label. Labels and timestamps wrap in narrow panes. Messages without a valid timestamp show only the label. It excludes thinking, tool calls/results, recap entries, and other extension messages. It follows the active session branch, including messages retained in the session after compaction, and updates as assistant text streams.

The split uses half the available columns per pane, apart from a one-column divider. Below 36 terminal columns the right pane is hidden so the feed remains usable; it reappears on resize. The toggle starts off in each session and after `/reload`. Switching away from fullscreen mode via `/settings` detaches the split; toggle it on again after returning to fullscreen.

## Compatibility

Pi's regular TUI writes to terminal scrollback, which cannot provide independent application-owned scrolling. The command reports that fullscreen mode is required if started without `--tui-mode fullscreen`. This extension reads the fullscreen TUI's internal `layoutRoot` field and checks for Pi's transcript/dock structure before replacing it; if that structure changes, enabling fails without altering the layout. Disabling or ending the session restores the original root. Pi 0.85.1 and 0.87.1 are tested runtimes; Pi 0.84.1 lacks the mouse and scrollbar styling APIs used here.
