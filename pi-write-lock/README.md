# write-lock

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that toggles a
session-scoped, read-only mode for the agent.

## Usage

```text
/write-lock             toggle the lock
/write-lock on          enable the lock (read-only)
/write-lock off         disable the lock (writes allowed)
/write-lock status      show the current state
```

The lock is off by default in a new session. Its state is stored in the session,
so it survives `/reload` and `/resume` and follows session-tree branches. A fork
inherits the state on the branch it was created from.

While the lock is on, the footer shows `write locked`.

## What it does

The extension uses several layers so the agent sees the restriction before it
tries to change anything:

1. Removes pi's built-in `edit` and `write` tools from the active tool list.
2. Adds a per-turn system instruction telling the agent to stay read-only and
   ask for `/write-lock off` when a task requires changes.
3. Hard-blocks direct file-mutation tools if one is called despite the missing
   tool definition.
4. Blocks common mutating Bash and PowerShell commands, including output
   redirection, file creation/deletion/movement, in-place formatters, package
   installs, archive extraction, and git commands that change repository state.

Read-only shell commands remain available. User-run `!`/`!!` shell commands are
not intercepted; the lock applies to agent tool calls.

## Safety boundary

This is a **balanced guardrail, not an operating-system sandbox**. Arbitrary
scripts, build/test commands, custom tools, or deliberately obfuscated shell can
still modify files if they are not recognized by the guard. The injected agent
instruction is intended to prevent those attempts, while the tool hook catches
common accidental writes.

Use a sandbox or filesystem permissions when you need a security boundary.

## Install

One-off test:

```bash
pi --no-extensions -e ./pi-write-lock/index.ts
```

To link every extension in this repository into both project-local and global
pi discovery locations:

```bash
node scripts/link-extensions.mjs
```
