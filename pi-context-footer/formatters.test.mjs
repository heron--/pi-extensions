import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatus, loadStatusFormatters } from "./formatters.ts";
import { fakeTheme, plain, scratch, startFooter } from "./harness.mjs";

let loads = 0;
const start = (options) => startFooter(new URL(`./index.ts?formatters=${loads++}`, import.meta.url).href, options);
const PINNED = { topLeft: ["model"], topRight: [], bottomLeft: [], bottomRight: [{ status: "example-work", color: "syntaxFunction" }] };
const bottom = (host, width = 120) => plain(host.renderEditor(width).at(-2));

function moduleFixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), "pi-footer-formatters-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "formatters #1.mjs");
	writeFileSync(file, source);
	return { root, file, configFile: join(root, "config.json") };
}

test("modules resolve relative, absolute and ~/ paths, and reload at the same path", async (t) => {
	const f = moduleFixture(t, 'export default { "example-work": text => `first:${text}` };');
	const first = await loadStatusFormatters("./formatters #1.mjs", f.configFile);
	assert.equal(first.get("example-work")("ready"), "first:ready");
	writeFileSync(f.file, 'export default { "example-work": text => `second:${text}` };');
	const second = await loadStatusFormatters(f.file, f.configFile);
	assert.equal(second.get("example-work")("ready"), "second:ready");
	const home = process.env.HOME;
	try {
		process.env.HOME = f.root;
		const tilde = await loadStatusFormatters("~/formatters #1.mjs", f.configFile);
		assert.equal(tilde.get("example-work")("ready"), "second:ready");
	} finally {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
	}
	assert.equal((await loadStatusFormatters(null, f.configFile)).size, 0);
});

test("bad module paths, syntax and exports fail at load, not render", async (t) => {
	const f = moduleFixture(t, "export default {};");
	await assert.rejects(loadStatusFormatters("./missing.mjs", f.configFile));
	for (const source of [
		"export default {", "export const unrelated = 1;", "export default null;", "export default [];",
		'export default { "": () => "x" };', 'export default { "example-work": "not a function" };',
	]) {
		writeFileSync(f.file, source);
		await assert.rejects(loadStatusFormatters(f.file, f.configFile), undefined, source);
	}
});

test("inputs and outputs are sanitized, with fallback and deliberate hiding", async () => {
	let received;
	const formatters = new Map([
		["normal", text => { received = text; return "\x1b[2Jshort\ntext\x1b[31m"; }],
		["decline", () => undefined], ["null", () => null], ["hide", () => ""],
		["throws", () => { throw new Error("bad display rule"); }], ["invalid", () => 42],
		["async", async () => { throw new Error("async callbacks are unsupported"); }],
	]);
	assert.equal(formatStatus("normal", "\x1b[34m original\ttext \x1b[0m", "normalized", formatters), "short text");
	assert.equal(received, "original text");
	for (const key of ["missing", "decline", "null", "throws", "invalid", "async"]) {
		assert.equal(formatStatus(key, "\x1b[31moriginal\x1b[0m", "normalized", formatters), "original", key);
	}
	assert.equal(formatStatus("hide", "original", "normalized", formatters), "");
	assert.equal(formatStatus("normal", "\n ", "normalized", formatters), "", "blank input cannot fabricate a status");
	const producer = formatStatus("normal", "original", "producer", formatters);
	assert.equal(plain(producer), "short text");
	assert.match(producer, /\x1b\[31m\x1b\[0m$/);
	await Promise.resolve();
});

test("the footer formats only selected display text, then applies color and width", async (t) => {
	const dirs = scratch({ config: { statusFormatters: "./formatters.mjs", layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeFileSync(join(dirs.agentDir, "pi-context-footer", "formatters.mjs"), 'export default { "example-work": text => text === "a verbose label" ? "short label" : undefined };');
	const theme = fakeTheme();
	const host = await start({ dirs, theme, statuses: { "example-work": "a verbose label" } });
	try {
		assert.match(bottom(host), /── short label ──╯$/);
		assert.ok(host.renderEditor(120).at(-2).includes(theme.fg("syntaxFunction", "short label")));
		assert.equal(host.state.statuses.get("example-work"), "a verbose label", "the producer and other consumers keep the original");
		host.ctx.ui.setStatus("example-work", "unknown label");
		assert.match(bottom(host), /── unknown label ──╯$/);
		writeFileSync(dirs.configFile, JSON.stringify({ statusFormatters: "./formatters.mjs", layout: { ...PINNED, bottomRight: [{ remainingStatuses: true, color: "syntaxFunction", maxWidth: 7 }] } }));
		await host.command("reload");
		host.ctx.ui.setStatus("example-work", "a verbose label");
		assert.match(bottom(host), /── short … ──╯$/);
		for (const width of [120, 60, 30, 24, 23]) {
			const rows = width < 24 ? host.renderFooter(width) : host.renderEditor(width);
			for (const row of rows) assert.ok(visibleWidth(row) <= width);
		}
	} finally {
		await host.shutdown();
	}
});

test("config reload refreshes modules, keeps the last valid one on failure, and can disable them", async (t) => {
	const dirs = scratch({ config: { statusFormatters: "./formatters.mjs", layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	const file = join(dirs.agentDir, "pi-context-footer", "formatters.mjs");
	writeFileSync(file, 'export default { "example-work": () => "first" };');
	const host = await start({ dirs, statuses: { "example-work": "original" } });
	try {
		assert.match(bottom(host), /── first ──╯$/);
		writeFileSync(file, 'export default { "example-work": () => "second" };');
		await host.command("reload");
		assert.match(bottom(host), /── second ──╯$/);
		writeFileSync(file, "export default {");
		await host.command("reload");
		assert.match(host.state.notifications.at(-2).message, /kept the previous status formatters/);
		assert.match(bottom(host), /── second ──╯$/);
		writeFileSync(dirs.configFile, JSON.stringify({ statusFormatters: 42, layout: PINNED }));
		await host.command("reload");
		assert.match(bottom(host), /── second ──╯$/);
		writeFileSync(dirs.configFile, JSON.stringify({ statusFormatters: null, layout: PINNED }));
		await host.command("reload");
		assert.match(bottom(host), /── original ──╯$/);
	} finally {
		await host.shutdown();
	}
});

test("a failed startup module warns and leaves ordinary statuses available", async (t) => {
	const host = await start({ config: { statusFormatters: "./missing.mjs", layout: PINNED }, statuses: { "example-work": "original" } });
	t.after(() => rmSync(host.dirs.root, { recursive: true, force: true }));
	try {
		assert.equal(host.state.notifications.length, 1);
		assert.match(host.state.notifications[0].message, /using unformatted statuses/);
		assert.match(bottom(host), /── original ──╯$/);
	} finally {
		await host.shutdown();
	}
});
