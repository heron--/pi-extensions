#!/usr/bin/env node
/**
 * Regenerate tsconfig.paths.json so TypeScript resolves the pi packages from
 * the pi install that is ACTUALLY on your PATH.
 *
 * Why not just `npm i -D @earendil-works/pi-coding-agent`?
 * Because extensions execute inside the installed pi runtime. If the
 * devDependency and the installed pi diverge (npm currently publishes ahead of
 * what may be installed locally), you would typecheck against APIs that are not
 * the ones running your code — the errors and the silence would both be lies.
 * Pointing at the live install makes drift structurally impossible.
 *
 * Run automatically via `npm run typecheck` (and on `npm install`), or by hand:
 *   node scripts/sync-pi-types.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tsconfig.paths.json");
const PKG = "@earendil-works/pi-coding-agent";

/** Walk up from a file until we find the package root containing package.json. */
function packageRootFrom(startPath) {
	let dir = existsSync(startPath) ? realpathSync(startPath) : startPath;
	for (let i = 0; i < 12; i++) {
		dir = dirname(dir);
		if (!dir || dir === "/") break;
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed = JSON.parse(readFileSync(manifest, "utf8"));
				if (parsed.name === PKG) return dir;
			} catch {
				// keep walking
			}
		}
	}
	return null;
}

function candidates() {
	const found = [];

	// 0. Explicit override always wins.
	if (process.env.PI_PACKAGE_ROOT) found.push(process.env.PI_PACKAGE_ROOT);

	// 1. Resolve Volta's selected package before npm's PATH prepends its Node image.
	if (process.env.VOLTA_HOME) {
		try {
			const target = execFileSync("volta", ["which", "pi"], { encoding: "utf8" }).trim();
			const root = packageRootFrom(target);
			if (root) found.push(root);
		} catch {
			// No Volta-managed pi; follow PATH below.
		}
	}

	// 2. Follow `pi` on PATH to its real target (handles npm/brew shims).
	let which = "";
	try {
		which = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
		const root = which ? packageRootFrom(which) : null;
		if (root) found.push(root);
	} catch {
		// pi not on PATH; fall through to the static candidates
	}

	// 3. The managed installer's launcher is a shell script in <agent>/bin that
	// execs <agent>/install/releases/<current-version>/node_modules/.bin/pi.
	const home = process.env.HOME ?? "";
	const agentDirs = [
		process.env.PI_CODING_AGENT_DIR,
		which ? dirname(dirname(which)) : undefined,
		`${home}/.pi/agent`,
	].filter(Boolean);
	for (const agentDir of agentDirs) {
		try {
			const current = readFileSync(join(agentDir, "install/current-version"), "utf8").trim();
			if (current) found.push(join(agentDir, "install/releases", current, "node_modules", PKG));
		} catch {
			// Not a managed install.
		}
	}

	// 4. Common install roots, for machines where pi is not on PATH.
	const statics = [
		`${home}/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/${PKG}`,
		`${home}/.bun/install/global/node_modules/${PKG}`,
		`/opt/homebrew/lib/node_modules/${PKG}`,
		`/usr/local/lib/node_modules/${PKG}`,
	];
	try {
		const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		if (npmRoot) statics.unshift(join(npmRoot, PKG));
	} catch {
		// npm unavailable; ignore
	}
	found.push(...statics);

	return found;
}

function findPiRoot() {
	for (const dir of candidates()) {
		if (existsSync(join(dir, "dist/index.d.ts"))) return dir;
	}
	return null;
}

const piRoot = findPiRoot();
if (!piRoot) {
	console.error(
		[
			"sync-pi-types: could not locate an installed @earendil-works/pi-coding-agent.",
			"",
			"Checked the `pi` binary on PATH plus the usual global install roots.",
			"If pi lives somewhere unusual, point this at it explicitly:",
			"  PI_PACKAGE_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent \\",
			"    node scripts/sync-pi-types.mjs",
		].join("\n"),
	);
	process.exit(1);
}

// Sibling packages are nested under pi's own node_modules by npm global
// installs and hoisted beside it by the managed installer.
const siblingRoots = [join(piRoot, "node_modules/@earendil-works"), dirname(piRoot)];
const version = (() => {
	try {
		return JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
})();

/** Sibling packages shipped inside pi's own node_modules. */
const siblings = ["pi-tui", "pi-ai", "pi-agent-core", "pi-protocol", "pi-client", "pi-telemetry"];

const paths = { [PKG]: [`${piRoot}/dist/index.d.ts`] };
const missing = [];
for (const name of siblings) {
	const entry = siblingRoots.map((root) => join(root, name, "dist/index.d.ts")).find((path) => existsSync(path));
	if (entry) {
		paths[`@earendil-works/${name}`] = [entry];
	} else {
		missing.push(name);
	}
}

const body = {
	__comment: [
		"GENERATED by scripts/sync-pi-types.mjs — do not edit by hand.",
		`Mapped to the live pi install (v${version}) so types always match the runtime.`,
		"Re-run `npm run typecheck` (or `npm run sync-types`) after upgrading pi.",
	],
	compilerOptions: { paths },
};

writeFileSync(OUT, `${JSON.stringify(body, null, "\t")}\n`);

console.log(`sync-pi-types: pi v${version}`);
console.log(`  root:    ${piRoot}`);
console.log(`  mapped:  ${Object.keys(paths).length} package(s) → tsconfig.paths.json`);
if (missing.length > 0) {
	console.log(`  skipped: ${missing.join(", ")} (not present in this pi install)`);
}
