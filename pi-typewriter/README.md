# typewriter

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that
reveals streamed assistant output with a classic **typewriter effect** —
roughly one character at a time, at a steady pace — instead of however much
text the provider has sent so far. Includes an Escape hatch to skip the
effect for a single message when you're in a rush.

Pi has no built-in "typing speed" setting — it draws whatever text has
arrived from the model so far, whenever it arrives. Fast/bursty streamers
(Opus in particular) can dump large blocks of text onto the screen almost
instantly, which for some people is genuinely motion-sickness inducing.

## How the animation works

Pi only re-renders a streaming message when its underlying text *changes*
— there's no per-frame animation timer exposed to extensions. A markdown
transformer alone can't animate between model deltas: it sits still, then
jumps once per delta to "whatever should be visible by now." To get a real
typewriter effect, something has to force a redraw on a timer, independent
of when deltas arrive.

The only extension-facing call that does this for the live streaming message
is `ctx.ui.setHiddenThinkingLabel()` — pinging it (with no argument, so it
doesn't change your configured label) makes pi rebuild the streaming
message, which re-runs this extension's markdown transformer. This
extension does that ~30 times/sec, **only while there's unrevealed text left
to show**, and stops automatically once the display catches up.

**Trade-off, stated plainly:** that rebuild call also touches every
finalized message in the conversation, not just the streaming one — there's
no cheaper public hook for this. In practice this is fast (just
re-tokenizing markdown, no model/network work), but in a very long session
it is doing more work than a purpose-built render timer would.
`/typewriter off` disables the tick loop entirely if you ever notice it
costing something.

This is display-only: the real message content, session file, and what's
sent back to the model are never touched.

## Escape hatch: skip the effect for one message

Press **Escape** while a message is typing out to show the rest of *that*
message immediately, at full speed. It does **not** abort generation — the
model keeps generating normally, the typewriter effect just stops holding
back what's on screen. The next assistant message types out as usual.

Escape only gets intercepted when there's actually unrevealed text being
held back right now. At every other time — nothing streaming, already
caught up, effect disabled — Escape passes through completely untouched
and behaves exactly as it always does (abort, cancel dialogs, double-escape
to `/tree`, etc.).

This couldn't be built with a normal keyboard shortcut: any extension
shortcut bound to Escape is checked *before* pi's built-in abort handling
and, once matched, swallows the keypress for good — abort would stop
working everywhere, for the rest of the session, not just during the
typewriter effect. Instead this uses a raw terminal-input listener that
decides, per keystroke, whether to consume Escape — so it only ever
intercepts it in the one situation that's actually relevant.

## Install

One-off test:

```
pi -e ~/Projects/heron--/pi-extensions/pi-typewriter/index.ts
```

Global (auto-loads every session):

```
cp -r pi-typewriter ~/.pi/agent/extensions/
```

Or register it in `~/.pi/agent/settings.json`:

```json
"packages": [
  "../../Projects/heron--/pi-extensions/pi-typewriter"
]
```

## Usage

```
/typewriter           show current rate
/typewriter 110        set reveal rate to 110 chars/sec (default)
/typewriter 60         slower, calmer
/typewriter 200        faster, barely-noticeable effect
/typewriter off        disable entirely (back to pi's normal instant streaming)
/typewriter on         re-enable at the last configured rate
```

While a message is typing out: **Escape** shows the rest of it instantly
(that message only).

Default is **110 chars/sec**. Valid range: 5–400 chars/sec. Set a different
default at startup:

```
PI_TYPEWRITER_CPS=80 pi
```

## Notes

- Applies to both the final answer text and thinking blocks (if
  `hideThinkingBlock` is off).
- Restored/finalized/user messages are never affected — only text that
  arrives while a message is actively streaming.
- The reveal advances by real elapsed time (a fractional accumulator), so
  the rate stays accurate regardless of how choppy the model's own delta
  timing is — that's the whole point of driving it off a timer instead of
  off delta arrival.
