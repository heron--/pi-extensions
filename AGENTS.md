# AGENTS.md — pi-extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) extensions.
This file exists so an agent editing here inherits the traps already found the
hard way, instead of rediscovering them by crashing pi.

Read this before touching anything under `.pi/extensions/`,
`~/.pi/agent/extensions/`, `lib/`, or `pi-model-picker/`.

## Layout

```
pi-extensions/
├── AGENTS.md               # this file
├── README.md               # setup + rationale (typecheck toolchain, lib/ pattern)
├── package.json             # dev toolchain only: typescript, sync-pi-types
├── tsconfig.json             # shared strict config, globs **/*.ts
├── tsconfig.paths.json       # GENERATED, gitignored — do not hand-edit
├── scripts/
│   ├── sync-pi-types.mjs    # points tsconfig at the LIVE pi install
│   └── link-extensions.mjs  # idempotently links every extension into both
│                             # discovery locations (by convention, not a list)
├── lib/
│   └── pricing.ts            # shared helper, imported as "../lib/pricing.ts"
├── pi-recap/           # extension: away-and-back recap, rotating cheap models
├── pi-context-footer/        # extension: continuous prompt border + status items
├── pi-model-picker/          # extension: /model-picker, and takes over /model
│   ├── index.ts
│   ├── package.json          # name: pi-model-picker
│   └── README.md
├── pi-typewriter/            # extension: /typewriter
│   ├── index.ts
│   ├── package.json
│   └── README.md
└── pi-write-lock/            # extension: /write-lock
    ├── index.ts
    ├── package.json
    └── README.md
```

Each `pi-*` directory is an independent pi package (`package.json` with a `pi`
key). The root `package.json` is deliberately **not** one — it has no `pi` key,
so pi never mistakes this directory itself for an extension.

## The symlink checklist (read this before adding an extension)

Extensions here are made runnable via symlinks in **two independent
locations**, and both are required for different reasons:

| Location | Scope | Trust required? |
|---|---|---|
| `.pi/extensions/<name>` (project-local, in this repo) | Only when `cwd` is inside `pi-extensions/` | Yes — directory must be in `~/.pi/agent/trust.json` |
| `~/.pi/agent/extensions/<name>` (global) | Every directory, every project | No |

**Neither symlink set updates itself.** Renaming an extension directory, or
adding a new one, means manually fixing both. There is no discovery of nested
directories and no way to point either location at a whole parent folder of
extensions — confirmed by testing, not assumed. The routine fix is
`node scripts/link-extensions.mjs` — idempotent, discovers extensions by
convention (any root directory whose `package.json` has a `pi` key, so no
edit is needed per extension), links `lib` alongside, and is called from the
dotfiles install script rather than every shell init (a link broken between
runs stays broken until the next run). The manual checklist below is the
fallback and the explanation of *why* the script does what it does. (A single `package.json` with
a `"pi": { "extensions": [...] }` array *can* bundle several extensions behind
one `pi install`, but that trades away installing/removing them one at a time,
which is the current preference here — do not switch to it without asking.)

**Checklist for a new extension `pi-thing`:**

1. `ln -s ../../pi-thing .pi/extensions/pi-thing` — project-local, for testing
   scoped to this directory.
2. `ln -s ~/Projects/heron--/pi-extensions/pi-thing ~/.pi/agent/extensions/pi-thing`
   — global, so it works from any directory.
3. If `pi-thing/index.ts` imports `../lib/...`, confirm the `lib` symlink
   already exists in whichever of those two locations you just touched (see
   below — it is easy to add the extension symlink and forget this one).
4. Verify from a directory that has never been touched — not this repo, not
   home. A stale symlink or a missing `lib` link fails **silently** (nothing
   registers, no error) or **loudly** (`Failed to load extension`), and both
   have happened here. Neither is caught by testing only from inside
   `pi-extensions/`.

**Checklist for renaming or removing an extension:** delete the *symlink*
first, in both locations, before renaming or deleting the target directory —
otherwise a rename can leave a symlink pointing at nothing, and pi errors on
next launch (this happened during the `pi-throttle-stream` → `pi-typewriter`
rename).

Currently symlinked, both locations: `pi-recap`, `pi-context-footer`, `pi-model-picker`,
`pi-typewriter`, `pi-write-lock`, `lib`.

## The `lib` symlink rule

**Relative imports resolve against the symlink path, not the real path.**

An extension discovered at `.pi/extensions/pi-model-picker/index.ts` resolves
`import ... from "../lib/pricing.ts"` as `.pi/extensions/lib/pricing.ts` — not
against the actual `lib/` next to `pi-model-picker/`. Without a `lib` symlink
sitting alongside the extension symlink, pi fails outright:

```
Error: Failed to load extension ".../.pi/extensions/pi-model-picker/index.ts":
Cannot find module '../lib/pricing.ts'
```

This is not a quirk of linking a directory specifically — linking the file
instead (`pi-model-picker.ts -> .../pi-model-picker/index.ts`) hits the exact
same resolution and the exact same failure. Confirmed by testing both.

Consequence: **`lib/` must never gain an `index.ts`.** If it did, both
`.pi/extensions/` and `~/.pi/agent/extensions/` would try to discover and load
it as an extension in its own right.

If you add a second shared helper file, it goes in `lib/` too — no new symlink
needed, the existing `lib` link already covers the whole directory.

## `pi-model-picker`: the `/model` takeover

`pi-model-picker` does two things: registers `/model-picker` normally, *and*
takes over the builtin `/model` command. The second part is not obvious from
reading `pi.registerCommand()` alone, so the mechanism is documented in
`index.ts` (`interceptModelCommand`) and repeated here because it is easy to
break without noticing:

- pi **refuses** to let an extension register a command literally named
  `model` — it's in `BUILTIN_SLASH_COMMANDS`, dropped from autocomplete with a
  conflict warning, and the TUI's `onSubmit` handler matches
  `text === "/model"` with a hardcoded `if` before extensions are ever
  consulted. Verified by reading pi's dispatch code, not assumed.
- The seam that works: pi routes submitted text through
  `editor.onSubmit`, and extensions can replace the editor entirely via
  `ctx.ui.setEditorComponent()`. Wrapping `onSubmit` there runs **before**
  pi's hardcoded check.
- **pi assigns `onSubmit` to the editor *after* the factory function
  returns.** Reading it during construction — or on a `setTimeout(0)` — reads
  `undefined`, and the wrapper silently never fires. It has to be an
  `Object.defineProperty` accessor, so it wraps whatever pi assigns, whenever
  it assigns it. This cost a failed attempt to discover; don't reintroduce a
  plain assignment as a "simplification."
- The takeover **composes** with any other extension's editor
  (`ctx.ui.getEditorComponent()` is called first, wrapped rather than
  clobbered) — but only if that other extension composes back. It does not,
  automatically, protect against an extension that discards the previous
  editor after constructing it.

### This already broke once, silently

`pi-powerline-footer` (previously in this machine's `settings.json` — since
removed) called `getEditorComponent()`, *constructed* the previous editor, and
then discarded it, keeping only its autocomplete provider. Our `onSubmit`
accessor lived on the discarded editor and never ran. Symptom: `/model`
silently fell back to pi's builtin, with zero errors anywhere. **Load order
could not have fixed this** — the previous editor's methods were never called
at all, regardless of who installed first.

Takeaway for any future extension that also wants the editor: **verify with a
live TUI test that your handler actually fires**, not just that
`setEditorComponent` was called without throwing. A `pty`-driven test typing
`/model` and asserting on the *actual* screen content is what caught this —
grepping for a plausible-sounding string is not enough (an earlier check here
asserted `"Switch between Claude models" not in screen`, which is Claude
Code's wording, not pi's; it passed while pi's builtin was in fact open).

If `/model` ever silently stops opening the picker again: check
`~/.pi/agent/settings.json` → `packages` for anything else calling
`setEditorComponent`, and confirm interactively — screen content, not string
guesses — that the wrapper is the one actually installed.

## Decorating the editor: pi's render-width assertion

`TuiMainScreen.doRender` throws if any rendered row's `visibleWidth()` exceeds
the terminal width — it tears the whole TUI down with
`Rendered line N exceeds terminal width`, which reads as "pi crashes on
opening". An earlier `pi-context-footer` did exactly that by prefixing a `│ `
rail onto the editor's content rows.

The reason it is a trap: `CustomEditor.render(width)` returns rows that are
**already exactly `width` cells wide** — a full-width rule, then
`leftPad + text + pad + rightPad` per line, then a second full-width rule, then
the autocomplete rows. Default `editorPaddingX` is `0`, so there is no slack to
borrow. Anything added to a row has to be paid for.

So a wrapper that wants a border does not prefix — it **renders the inner editor
narrow** (`baseRender(width - 2)`) and wraps each returned row. Other things
worth knowing before touching that seam:

- The lower rule is **not** the last row. Pi appends completion rows after it
  when autocomplete is open, so find it by scanning backwards for a rule row
  rather than taking `lines.length - 1`.
- The cursor position is recovered by `indexOf(CURSOR_MARKER)` plus
  `visibleWidth()` of everything before it, so prefixing a rail shifts the
  hardware cursor correctly and needs no extra bookkeeping. `visibleWidth()`
  does understand the marker's APC escape, so it does not distort widths.
- Paint the border with `editor.borderColor`, not a fixed theme color. Pi
  reassigns that property on the *active* editor to signal bash mode and
  thinking level (`updateEditorBorderColor`), so reading it per render keeps a
  custom frame in step instead of overriding pi's own signalling.
- `autocompleteState` and the row layout are private; do not reach for them.
  Structure detection off the returned rows is enough and does not break when
  pi's internals move.

## Calling a model, and knowing the user is there

Two seams `pi-recap` needed that are not obvious from the extension types.

**A one-off LLM call.** There is no `generate`/`complete` helper on
`ExtensionContext`. The path is `ctx.modelRegistry`:

```ts
const model = ctx.modelRegistry.getAvailable().find(/* … */);
if (!ctx.modelRegistry.hasConfiguredAuth(model)) return;
const reply = await ctx.modelRegistry.complete(
  model,
  { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] },
  { maxTokens: 400, signal },
);
```

`complete()` resolves provider auth and headers itself — do not go looking for
an API key to pass in. Match models by id pattern rather than
`provider/id`: the same model shows up under different provider names depending
on how the gateway is configured, and `ctx.model` is the *session's* model, not
a way to reach a different one. Always pass a `signal` with a timeout; a
courtesy feature must not be able to hang a session.

**Whether the user is at the keyboard.** pi does not forward the terminal's
focus events to extensions, so there is no way to distinguish "walked away"
from "sat and read the whole run". What exists:

- the `input` event fires on *submit*, carrying the finished text — it is not a
  keystroke stream, so it is too late to greet someone who just came back
- the editor's `handleInput` is the only pre-submit signal, reachable by
  wrapping it the same way `pi-context-footer` wraps `render`

So presence is "keystrokes seen recently", and that limitation belongs in the
extension's README rather than being papered over. Do not update the
last-seen timestamp on agent events: a long run the user waited through is
exactly the case where a recap is wanted, and refreshing the clock on the
agent's own activity would suppress it.

## Typechecking

```bash
npm install          # once
npm run typecheck     # check every extension
npm run watch         # re-check on save
```

Globs `**/*.ts`, so a new extension needs no config change. Types resolve from
the **live pi install on `PATH`** (`scripts/sync-pi-types.mjs`), not from an
npm devDependency — npm has published ahead of what's actually installed here
before (0.85.0 vs a running 0.84.x), so a devDependency would silently
typecheck against APIs that are not the ones executing the code.
`tsconfig.paths.json` is generated and gitignored; re-run `npm run typecheck`
after upgrading pi to re-point at the new install.

## Before claiming something works

Everything above was found by actually running pi in a pty and reading the
resulting screen — not by reading pi's source and reasoning about what
*should* happen. Three separate claims in this project's history turned out
to be wrong under that standard: symlinks resolving `../lib/` (they don't),
`getEditorComponent()` composing safely by default (it doesn't, if the
composer discards the result), and a builtin-vs-extension check that read the
wrong reference string. Prefer the same standard for new claims: launch pi
for real, type the thing, look at the screen.

A `pty`-plus-`pyte` harness is the cheap way to do that: fork pi under a pty at
a fixed winsize, feed it keystrokes, and read the decoded screen back. It is
what confirmed the prompt frame closes at 100, 60, 40, and 26 columns, steps
aside at 22, survives an open completion list and a scrolled input, and toggles
off and on — none of which is visible from reading pi's source.
