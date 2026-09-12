#!/usr/bin/env node
/**
 * Launch a real, interactive `pi` TUI loaded with ONLY this checkout's
 * extensions, pre-seeded with a synthetic transcript so their UI is visible
 * immediately: a boxed user message (pi-user-message), a thinking block
 * (pi-thinking-labels), a tool call + result (pi-tool-output), a generated
 * recap card (pi-recap), and the bordered model/context/branch footer
 * (pi-context-footer). pi-model-picker,
 * pi-typewriter, and pi-write-lock load too and are exercised by hand (see
 * "What to try" below) since they need a live keypress, not a static entry.
 *
 * Deliberately a real TUI, not a captured screen dump: colors, box-drawing,
 * and interactive commands (/model-picker, Ctrl+O, /write-lock) all matter
 * for visual inspection, and only a live terminal shows them faithfully.
 *
 * Scoping: `--no-extensions` plus one `-e <path>` per extension (discovered
 * the same way scripts/link-extensions.mjs does — any repo-root directory
 * whose package.json carries a `pi.extensions` array) means ONLY this
 * checkout's extensions load. No `~/.pi/agent/extensions` globals, no
 * duplicates, and edits here take effect on the next run with no re-link.
 *
 * The seeded session is a scratch file (not one of your real sessions) in a
 * fresh temp directory, cleaned up on exit — this script never touches
 * ~/.pi/agent/sessions or any file already on disk. Continuing the session
 * inside pi (or sending a real message) uses your normal model/auth config;
 * this script does not perform any model calls itself.
 *
 * Usage:
 *   node scripts/preview-extensions.mjs [-- <extra pi args>]
 *
 * Examples:
 *   node scripts/preview-extensions.mjs
 *   node scripts/preview-extensions.mjs -- --thinking low
 *   node scripts/preview-extensions.mjs -- --use-theme frontier-funds
 *
 * What to try once it opens:
 *   - Ctrl+O on the rendered grep result: pi-tool-output's expand/collapse.
 *   - /model-picker (or /model): pi-model-picker's takeover of the
 *     built-in command.
 *   - Type "!" at the start of the input: pi-context-footer's bash-mode tint.
 *   - /write-lock: pi-write-lock's status pill in the footer's lower rule.
 *   - Send a real message and step away past the recap threshold (or run
 *     `/recap now`) to see pi-recap fire.
 *   - Quit with Ctrl+D on an empty editor or /quit; the scratch session is removed automatically.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* -------------------------------------------------------------------------- */
/* Discover this checkout's extensions — same convention as link-extensions.mjs */
/* -------------------------------------------------------------------------- */

function discoverExtensionEntries() {
	const entries = [];
	const directoryNames = readdirSync(REPO_ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	for (const name of directoryNames) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const dir = join(REPO_ROOT, name);
		const manifestPath = join(dir, "package.json");
		if (!existsSync(manifestPath)) continue;
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			continue;
		}
		const declared = manifest?.pi?.extensions;
		if (!Array.isArray(declared)) continue;
		for (const relPath of declared) {
			if (typeof relPath === "string") entries.push(join(dir, relPath));
		}
	}
	return entries.sort();
}

/* -------------------------------------------------------------------------- */
/* A synthetic transcript: just enough to light up every extension's render  */
/* -------------------------------------------------------------------------- */

function shortId() {
	return randomBytes(4).toString("hex");
}

function buildSeedSession() {
	const nowIso = () => new Date().toISOString();
	const nowMs = () => Date.now();
	const usage = (input, output) => ({
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	const entries = [];
	let parentId = null;
	function push(entry) {
		entries.push({ ...entry, id: shortId(), parentId, timestamp: nowIso() });
		parentId = entries.at(-1).id;
	}

	entries.push({
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: nowIso(),
		cwd: REPO_ROOT,
	});
	push({ type: "model_change", provider: "ai-gw-anthropic-1m", modelId: "anthropic/claude-sonnet-5" });
	push({ type: "thinking_level_change", thinkingLevel: "high" });
	push({
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "Grep for TODO markers in lib/box.ts" }],
			timestamp: nowMs(),
		},
	});

	const toolCallId = `preview-${shortId()}`;
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should grep the file for TODO markers." },
				{ type: "toolCall", id: toolCallId, name: "grep", arguments: { pattern: "TODO", path: "lib/box.ts" } },
			],
			api: "anthropic-messages",
			provider: "ai-gw-anthropic-1m",
			model: "anthropic/claude-sonnet-5",
			usage: usage(500, 40),
			stopReason: "toolUse",
			timestamp: nowMs(),
		},
	});
	push({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "grep",
			content: [{
				type: "text",
				text: Array.from(
					{ length: 12 },
					(_value, index) => `lib/box.ts:${index + 10}: preview match ${index + 1}`,
				).join("\n"),
			}],
			isError: false,
			timestamp: nowMs(),
		},
	});
	push({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "The seeded preview includes 12 simulated grep matches so Ctrl+O visibly expands and collapses the tool box." }],
			api: "anthropic-messages",
			provider: "ai-gw-anthropic-1m",
			model: "anthropic/claude-sonnet-5",
			usage: usage(500, 20),
			stopReason: "stop",
			timestamp: nowMs(),
		},
	});
	push({
		type: "custom",
		customType: "recap",
		data: {
			text: [
				"Recap: Loaded every extension from this checkout into a synthetic session, including the boxed user message, thinking label, expandable tool output, and context footer.",
				"Next: Press Ctrl+O to compare the collapsed and expanded tool box.",
			].join("\n"),
			modelName: "Preview Model",
			stamp: "9:41am, September 12",
		},
	});

	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const extensionEntries = discoverExtensionEntries();
if (extensionEntries.length === 0) {
	console.error(`No extensions found under ${REPO_ROOT} (looked for */package.json with a "pi.extensions" array).`);
	process.exit(1);
}

const scratchDir = mkdtempSync(join(tmpdir(), "pi-extensions-preview-"));
const sessionPath = join(scratchDir, "seed-session.jsonl");
writeFileSync(sessionPath, buildSeedSession(), "utf8");

const passthroughArgs = process.argv.slice(2);
const doubleDash = passthroughArgs.indexOf("--");
const extraPiArgs = doubleDash === -1 ? passthroughArgs : passthroughArgs.slice(doubleDash + 1);

const extensionFlags = extensionEntries.flatMap((entryPath) => ["-e", entryPath]);
const piArgs = ["--no-extensions", ...extensionFlags, "--session", sessionPath, ...extraPiArgs];

console.log(`pi-extensions preview: loading only this checkout's extensions —`);
for (const entryPath of extensionEntries) console.log(`  - ${entryPath}`);
console.log(`Scratch session: ${sessionPath}`);
console.log(`Running: pi ${piArgs.join(" ")}\n`);

function cleanup() {
	rmSync(scratchDir, { force: true, recursive: true });
}

const child = spawn("pi", piArgs, { cwd: REPO_ROOT, stdio: "inherit" });
child.on("exit", (code, signal) => {
	cleanup();
	process.exit(signal ? 1 : (code ?? 0));
});
child.on("error", (error) => {
	console.error(`Failed to launch pi: ${error.message}`);
	cleanup();
	process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (!child.killed) child.kill(signal);
	});
}
