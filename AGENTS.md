# AGENTS.md — pi-extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) extensions.
This file aligns every agent working here on one way of working. Read it before
changing anything.

## Documentation

Documentation holds high-level principles and ideas. It is not a record of how
the code works, and it is not a pull request description. Keep it clean,
concise, consistent, and generally applicable. How a piece of code works
belongs in comments beside that code; why one change was made belongs in its
commit and pull request.

## Verify in pi, not in your head

A claim about pi's behaviour is true only once it has been seen on a real
screen. Reading pi's source and reasoning about what should happen has been
wrong here more than once. Launch pi in a pty, drive it with real keystrokes,
and assert on the decoded screen (a `pty` + `pyte` harness is the cheap way),
at several terminal widths. Unit tests catch drift; they do not prove the UI.

Test against the pi that is actually installed. Types and tests resolve from
the live pi on `PATH`, never from an npm devDependency, because npm can publish
ahead of what runs. Re-run `npm run typecheck` after upgrading pi.

```bash
npm install          # once
npm run check        # typecheck and every test suite
```

## Extensions

Each `pi-*` directory is an independent pi package (a `package.json` with a
`pi` key). The root `package.json` deliberately has none, and anything that
finds extensions does so by that convention.

Extensions run from symlinks, and relative imports resolve against the symlink
path, not the real path, so shared code lives in `lib/` and is linked beside
the extensions. `lib/` must never contain an `index.ts`, or pi will load it as
an extension. Verify a new extension from a directory outside this repo: there
it loads through its global link, the kind `install.sh` creates.

`install.sh` is how someone who clones the repo installs it: it links only the
extensions they choose, into the global directory, and offers the settings each
one declares under `settings` in its `package.json`. A declared default must
match the code's default, and the extension's tests check that.

## Changing pi's behaviour

Prefer pi's public extension API. When an extension has to wrap or patch
something pi owns (the editor, a component's prototype), it must:

- compose with whatever is already installed instead of replacing it;
- restore exactly what it changed on shutdown;
- never let its own failure take the TUI down.

pi tears the whole TUI down when a rendered row is wider than the terminal.
Anything that decorates rendered rows pays for its width by rendering the inner
content narrower, never by prefixing rows that are already full width.

## Performance

Measure before optimising, and measure with the checked-in synthetic profilers
(`npm run profile:*`), never with personal session files. Compare medians of
several runs, against a baseline at identical arguments. Every frame redraws
the whole transcript, so work that scales with transcript length belongs behind
a cache.

## Private data

Nothing private enters the repo: no personal transcripts, and no real pricing
or contract rates. User-owned configuration lives under pi's agent directory,
outside the paths the install symlinks resolve into this checkout.

## Calling a model

Use `ctx.modelRegistry`: check `hasConfiguredAuth`, then `complete()`, which
resolves auth itself. Match models by id pattern, not `provider/id`. Always
pass a `signal` with a timeout: a courtesy feature must never hang a session.

## Pull requests and automated review

Automated review agents only start once a pull request is marked ready for
review; a draft gets no review. When polling for review status, check the emoji
reactions on the PR description as well as comments: a reviewer with nothing to
report may only react there.

Evaluate every automated finding before fixing it. All code has bugs, so
finding an edge case is not on its own a reason to change anything. Beyond
being correct, which is a given, a finding is fixed only when:

- it is appropriate to the scale and context of this project; and
- fixing it costs less than shipping the bug. The cost of a fix includes the
  complexity and scope it adds to the software.

A finding that fails either test gets a short reply saying why, not a change.
