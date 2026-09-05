# pi-extensions

Personal pi extensions, plus a shared dev-only TypeScript toolchain.

Each subdirectory is an independent pi package (its own `package.json` with a
`pi` key). This root is **not** a pi package — it exists only to give every
extension a single typechecker.

## Typechecking

```
npm install          # once
npm run typecheck    # check every extension
npm run watch        # re-check on save
```

`npm run typecheck` covers all `**/*.ts` under this directory, so a new
extension is picked up automatically with no config change.

## How the pi types are resolved

The pi packages are **not** installed as devDependencies. Instead,
`scripts/sync-pi-types.mjs` locates the pi install that is actually on your
`PATH` and writes `tsconfig.paths.json` pointing at it.

This is deliberate. Extensions execute inside the installed pi runtime, and the
npm-published version routinely runs ahead of what is installed locally (npm was
at 0.85.0 while this machine ran 0.84.1). A devDependency would mean
typechecking against APIs that are not the ones running your code — so both the
errors *and* the silence would be untrustworthy. Mapping to the live install
makes that drift structurally impossible, and costs no extra download.

It also means: **after upgrading pi, re-run `npm run typecheck`** (or
`npm run sync-types`) to re-point at the new install. If pi lives somewhere
unusual, override the lookup:

```
PI_PACKAGE_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent npm run sync-types
```

`tsconfig.paths.json` is generated and gitignored — it holds machine-specific
absolute paths. `npm install` recreates it via `postinstall`.

## Layout

```
pi-extensions/
├── package.json           # typescript (dev) + shared runtime deps
├── tsconfig.json          # shared strict config, globs all extensions
├── tsconfig.paths.json    # GENERATED, gitignored
├── scripts/
│   └── sync-pi-types.mjs
├── lib/                   # shared helpers, imported as "../lib/x.ts"
│   └── pricing.ts
└── pi-model-picker/       # an extension
    ├── package.json       # has the "pi" key
    ├── index.ts
    └── README.md
```

## Shared helpers (`lib/`)

Code used by more than one extension goes in `lib/` and is imported with a
relative path:

```ts
import { getPricing, formatPricing } from "../lib/pricing.ts";
```

Runtime deps for shared helpers go in this root `package.json` under
`dependencies` (not `devDependencies`) — pi resolves `node_modules` from a
parent directory, so extensions pick them up automatically.

**Trade-off:** an extension that imports `../lib/` is no longer
copy-paste-portable on its own. That's fine while everything lives here; if one
ever needs to ship standalone, inline the helper or vendor it into that
extension's own directory.

## Loading extensions while developing

`.pi/extensions/` is auto-discovered (once the directory is trusted), so `pi`
with no flags loads whatever is linked there, and `/reload` hot-reloads it:

```
.pi/extensions/
├── lib                -> ../../lib                 # REQUIRED, see below
├── pi-model-picker    -> ../../pi-model-picker
└── pi-typewriter -> ../../pi-typewriter
```

Add or remove links freely — `.pi/` is gitignored, so it never shows up in
`git status`. For a one-off experiment, drop a plain `.ts` file in there (that
path is discovered too) and delete it when done; or skip the directory entirely
and use `pi -e ./pi-thing/index.ts`.

### The `lib` symlink is required, not decorative

**Relative imports resolve against the symlink path, not the real path.** An
extension discovered at `.pi/extensions/pi-model-picker/index.ts` resolves
`../lib/pricing.ts` to `.pi/extensions/lib/pricing.ts` — *not* to the real
`lib/`. Without the `lib` symlink, pi fails to start from this directory:

```
Error: Failed to load extension ".pi/extensions/pi-model-picker/index.ts":
Cannot find module '../lib/pricing.ts'
```

So: **any extension linked into `.pi/extensions/` that imports `../lib/`
requires the `lib` symlink alongside it.** Linking the file instead of the
directory (`pi-model-picker.ts -> ../../pi-model-picker/index.ts`) does not help
— same resolution, same failure.

This also means `lib/` must not gain an `index.ts`, or discovery would try to
load it as an extension.

### Trusting the directory

Project-local `.pi/extensions` only loads after the directory is trusted. pi
prompts on first interactive run; the decision is stored in
`~/.pi/agent/trust.json` keyed by canonical absolute path (lookup walks up
parent directories, so trusting a parent covers children).

### `lib/pricing.ts`

Model pricing, with estimates for models pi has no price for.

pi only knows a price when a model definition carries a `cost` block. Custom and
gateway providers (anything from `models.json`) usually omit it, and **pi
zero-fills the gap**, so the cost reads as `$0` rather than "unknown". This
helper detects that and falls back to
[`@pydantic/genai-prices`](https://github.com/pydantic/genai-prices) — a
community price dataset that ships bundled, so there's no network call at render
time.

```ts
const p = getPricing(model);   // { input, output, source } | null
formatPricing(p);              // "$3/$15" | "~$3/$15" | null
```

- `source: "pi"` — pi's own figure. Rendered plain: `$3/$15`.
- `source: "estimate"` — from the dataset. Rendered with `~`: `~$3/$15`.
- `null` — genuinely unknown. Callers decide what to show; don't substitute 0.

Estimates match on model id against **public list prices**, so they ignore
gateway contracts, negotiated rates, cache/batch pricing, and anything
self-hosted. Fine for comparing models while working; not a billing source.
**Keep the `~` marker** in any UI built on this.

Coverage is broad but not complete. Misses return `null`.

Two implementation details worth not re-discovering:

- The dataset is probed with **1000 tokens**, not 1M. At 1M, Anthropic's
  >200K long-context tier engages and `claude-sonnet-4-5` reports `$6/$22.50`
  instead of its `$3/$15` base rate.
- pi ids need normalizing before they match
  (`anthropic/claude-haiku-4-5-20251001` → `claude-haiku-4-5`). `idCandidates()`
  tries progressively-stripped forms. The vendor-prefix strip is guarded on a
  dotted prefix, because stripping blindly turned `gemini-3.8-flash` into
  `8-flash`.

If `@pydantic/genai-prices` isn't installed, estimates return `null` instead of
throwing — the extension keeps working, just without them.

## Adding an extension

1. `mkdir pi-my-thing` with an `index.ts` and a `package.json` carrying a `pi`
   key (copy `pi-model-picker/package.json` as a starting point).
2. `npm run typecheck` — no config change needed.
3. Test it: `pi -e ./pi-my-thing/index.ts`
