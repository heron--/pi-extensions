#!/usr/bin/env node
/**
 * Symlink every extension in this repo into both discovery locations pi
 * reads, and trust this repo directory, so a fresh checkout (new VM,
 * dotfiles bootstrap) behaves like an already-set-up one.
 *
 *   .pi/extensions/<name>        -> ../../<name>   (project-local; requires
 *                                                    trust; only active when
 *                                                    cwd is inside this repo)
 *   ~/.pi/agent/extensions/<name> -> <repo>/<name>  (global; no trust gate;
 *                                                    active from anywhere)
 *
 * Extensions are discovered by convention, not hardcoded: any directory at
 * the repo root with a package.json carrying a "pi": { "extensions": [...] }
 * key. Adding a new pi-thing/ directory needs no edit here.
 *
 * lib/ is symlinked alongside every extension in both locations, unconditionally.
 * Relative imports (e.g. "../lib/pricing.ts") resolve against the SYMLINK
 * path, not the real path, so any extension importing ../lib/ silently fails
 * to load without it — see AGENTS.md. lib/ must never gain an index.ts, or
 * discovery would try to load it as an extension in its own right.
 *
 * IDEMPOTENT: state is checked (via realpath, not raw symlink text, so a
 * syntactically different but equivalent target does not count as drift)
 * before anything is planned. If nothing needs doing, this exits silently
 * with no prompt.
 *
 * NEVER overwrites a real (non-symlink) file or directory in the way; that
 * is reported and skipped, not deleted.
 *
 * Meant to be called once from a dotfiles install script, same as that
 * script's tmux/nvim config-linking steps — see heron--dotfiles/install.sh
 * for the call site. Deliberately does NOT run this on every shell init;
 * there is no per-shell cache here because there is nothing that needs one.
 * If a symlink breaks between install.sh runs (e.g. deleted by hand), it
 * stays broken until the next run — same as a broken tmux/nvim link would.
 *
 * Usage:
 *   node scripts/link-extensions.mjs            # plan, confirm, apply
 *   node scripts/link-extensions.mjs --yes       # skip the confirmation
 *   node scripts/link-extensions.mjs --status    # report only, never prompts/writes
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const HOME = process.env.HOME ?? "";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi/agent");
const GLOBAL_EXT_DIR = join(AGENT_DIR, "extensions");
const PROJECT_EXT_DIR = join(REPO_ROOT, ".pi/extensions");
const TRUST_PATH = join(AGENT_DIR, "trust.json");

const args = new Set(process.argv.slice(2));
const FLAG_YES = args.has("--yes") || args.has("-y");
const FLAG_STATUS = args.has("--status") || args.has("--check") || args.has("--dry-run");
const FLAG_HELP = args.has("--help") || args.has("-h");

if (FLAG_HELP) {
	console.log(
		[
			"Usage: node scripts/link-extensions.mjs [--yes] [--status]",
			"",
			"  (no flags)   Plan, print it, ask to confirm, apply. Exits silently",
			"               with no prompt if everything is already set up.",
			"  --yes, -y    Apply the plan without confirming.",
			"  --status     Report state only. Never prompts, never writes.",
		].join("\n"),
	);
	process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/** Directories at the repo root with a package.json carrying pi.extensions. */
function discoverExtensions() {
	const found = [];
	for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const manifestPath = join(REPO_ROOT, entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (Array.isArray(manifest?.pi?.extensions)) {
				found.push(entry.name);
			}
		} catch {
			// Not valid JSON, or no pi.extensions — not an extension we manage.
		}
	}
	return found.sort();
}

const extensionNames = discoverExtensions();
const hasLib = existsSync(join(REPO_ROOT, "lib"));
/** Every name that gets a symlink in both locations: extensions, plus lib/. */
const linkNames = hasLib ? [...extensionNames, "lib"] : extensionNames;

if (extensionNames.length === 0) {
	console.error(`No extensions found under ${REPO_ROOT} (looked for */package.json with a "pi.extensions" array).`);
	process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* State inspection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Compare a symlink's target against the desired target by REALPATH, not raw
 * text — a relative vs. absolute spelling of the same file is not drift.
 */
function inspectLink(linkPath, desiredTargetRealPath) {
	if (!existsSync(linkPath) && !isDanglingSymlink(linkPath)) {
		return { state: "missing" };
	}
	const st = lstatSync(linkPath);
	if (!st.isSymbolicLink()) {
		return { state: "occupied", detail: st.isDirectory() ? "directory" : "file" };
	}
	const rawTarget = readlinkSync(linkPath);
	let currentReal;
	try {
		currentReal = realpathSync(linkPath);
	} catch {
		return { state: "dangling", rawTarget };
	}
	if (currentReal === desiredTargetRealPath) return { state: "ok" };
	return { state: "wrong-target", rawTarget, currentReal };
}

function isDanglingSymlink(p) {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function planLinkAction(linkPath, targetPath, targetRealPath, describeLinkPath) {
	const info = inspectLink(linkPath, targetRealPath);
	switch (info.state) {
		case "ok":
			return null;
		case "missing":
			return { kind: "create-link", linkPath, targetPath, describe: `create  ${describeLinkPath}` };
		case "dangling":
		case "wrong-target":
			return {
				kind: "relink",
				linkPath,
				targetPath,
				describe: `relink  ${describeLinkPath}\n           was: ${info.rawTarget}\n           now: ${targetPath}`,
			};
		case "occupied":
			return {
				kind: "skip-occupied",
				linkPath,
				describe: `SKIP    ${describeLinkPath} — a real ${info.detail} is there; not touching it`,
			};
		default:
			return null;
	}
}

/* -------------------------------------------------------------------------- */
/* Trust                                                                      */
/* -------------------------------------------------------------------------- */

function readTrust() {
	if (!existsSync(TRUST_PATH)) return {};
	try {
		return JSON.parse(readFileSync(TRUST_PATH, "utf8"));
	} catch {
		return {};
	}
}

function planTrustAction() {
	const canon = existsSync(REPO_ROOT) ? realpathSync(REPO_ROOT) : REPO_ROOT;
	const data = readTrust();
	if (data[canon] === true) return null;
	return {
		kind: "trust",
		path: canon,
		describe: `trust   ${canon}`,
	};
}

/* -------------------------------------------------------------------------- */
/* Build the plan                                                             */
/* -------------------------------------------------------------------------- */

const plan = [];

for (const name of linkNames) {
	const targetPath = join(REPO_ROOT, name);
	const targetRealPath = realpathSync(targetPath);

	// Project-local: relative target, matching the existing convention there.
	const projectLink = join(PROJECT_EXT_DIR, name);
	const projectRelTarget = relative(PROJECT_EXT_DIR, targetPath);
	const projectAction = planLinkAction(
		projectLink,
		projectRelTarget,
		targetRealPath,
		`.pi/extensions/${name}`,
	);
	if (projectAction) plan.push(projectAction);

	// Global: absolute target — there is no stable relative path from
	// ~/.pi/agent/extensions to an arbitrary repo location.
	const globalLink = join(GLOBAL_EXT_DIR, name);
	const globalAction = planLinkAction(
		globalLink,
		targetPath,
		targetRealPath,
		`~/.pi/agent/extensions/${name}`,
	);
	if (globalAction) plan.push(globalAction);
}

const trustAction = planTrustAction();
if (trustAction) plan.push(trustAction);

/* -------------------------------------------------------------------------- */
/* Status-only / already-set-up exits                                        */
/* -------------------------------------------------------------------------- */

console.log(`pi-extensions: ${extensionNames.join(", ")}${hasLib ? " (+ lib)" : ""}`);

if (plan.length === 0) {
	console.log("Already set up — nothing to do.");
	process.exit(0);
}

if (FLAG_STATUS) {
	console.log("\nWould do:");
	for (const action of plan) console.log(`  ${action.describe}`);
	process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Confirm                                                                    */
/* -------------------------------------------------------------------------- */

console.log("\nPlan:");
for (const action of plan) console.log(`  ${action.describe}`);

/**
 * Read one y/N answer from stdin (works whether stdin is a real TTY or piped,
 * e.g. `echo y | node link-extensions.mjs`). If stdin closes with no answer at
 * all (invoked with stdin from /dev/null, as cron or some wrappers do), that
 * is treated as "no" rather than hanging or silently proceeding.
 */
function confirm(question) {
	if (FLAG_YES) return Promise.resolve(true);

	return new Promise((resolvePromise) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let answered = false;
		rl.question(`${question} [y/N] `, (answer) => {
			answered = true;
			rl.close();
			resolvePromise(/^y(es)?$/i.test(answer.trim()));
		});
		rl.on("close", () => {
			if (!answered) resolvePromise(false);
		});
	});
}

const ok = await confirm("\nApply this plan?");
if (!ok) {
	console.log("Aborted — nothing changed.");
	process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                      */
/* -------------------------------------------------------------------------- */

for (const action of plan) {
	if (action.kind === "create-link" || action.kind === "relink") {
		mkdirSync(dirname(action.linkPath), { recursive: true });
		if (action.kind === "relink") {
			rmSync(action.linkPath, { force: true });
		}
		symlinkSync(action.targetPath, action.linkPath);
	} else if (action.kind === "trust") {
		mkdirSync(dirname(TRUST_PATH), { recursive: true });
		const data = readTrust();
		data[action.path] = true;
		const tmp = `${TRUST_PATH}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		renameSync(tmp, TRUST_PATH);
	}
	// skip-occupied: nothing to apply, already reported above.
}

console.log("\nDone.");
