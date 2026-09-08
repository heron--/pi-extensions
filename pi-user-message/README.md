# user-message

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that draws
the user's message in the house box:

```text
╭ ● User ────────────────────────────────────╮
│ what shape should the border take?         │
╰────────────────────────────────────────────╯
```

The box is the same layout language as `pi-context-footer`'s prompt frame and
`pi-recap`'s recap frame — this is the box that inspired them — and it is
generated from [`lib/box.ts`](../README.md#libboxts), the shared row builders.

- **Content stays pi's.** The renderer frames the native message component's
  own body (markdown, theme colors, message transforms, background) at
  rail-to-rail width; only the box is drawn here.
- **Shell integration survives.** pi's OSC133 zone markers are re-wrapped
  around the box, so terminal scrollback still sees one user-input zone.
- **Narrow terminals** (below 12 columns) render pi's native message.

## Mechanism

pi exports its native `UserMessageComponent`; restyling a built-in message
means patching that prototype's `render` — there is no public hook for it. The
original render is kept (fallback, restore-on-shutdown), and the patch is
idempotent across session reloads. This replaces the user-message box of the
third-party `pi-tool-display` — turn its `enableNativeUserMessageBox` off so
one patch owns the prototype; its tool/diff rendering is unaffected.

## Install

One-off test: `pi -e <this directory>/index.ts`. For everyday use see the
workspace [README](../README.md#loading-extensions-while-developing) — this
extension is picked up by the same symlink conventions as its siblings (it
imports [`../lib/box.ts`](../lib/box.ts), so the `lib` symlink covers it).

## Usage

```text
/user-message          report whether the box is on
/user-message on|off   toggle it (persisted in the agent config directory)
```
