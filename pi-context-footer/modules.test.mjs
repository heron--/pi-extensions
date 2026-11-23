import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadModules, NO_MODULES, statusText } from "./modules.ts";
import { testTheme } from "../lib/test-theme.mjs";
import { plain, scratch, startFooter } from "./harness.mjs";

let loads = 0;
const start = (options) => startFooter(new URL(`./index.ts?modules=${loads++}`, import.meta.url).href, options);
const PINNED = { topLeft: ["model"], topRight: [], bottomLeft: [], bottomRight: [{ status: "example-work", color: "syntaxFunction" }] };
const bottom = (host, width = 120) => plain(host.renderEditor(width).at(-2));
const CONTEXT = { sessionId: "session-1" };

function moduleFixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), "pi-footer-modules-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "module #1.mjs");
	writeFileSync(file, source);
	return { root, file, configFile: join(root, "config.json") };
}

/** A module file beside the scratch config, for footer-level tests. */
function writeModule(dirs, name, source) {
	writeFileSync(join(dirs.agentDir, "pi-context-footer", name), source);
}

/**
 * A module that counts events in module state and shows the count beside the
 * published status, so event delivery and state are both visible on screen.
 */
const COUNTER = `
let count = 0;
export default {
	events: { "example:tick": () => { count++; } },
	statuses: { "example-work": (text) => \`\${text ?? "none"} ×\${count}\` },
};`;

test("modules resolve relative, absolute and ~/ paths, and each load starts fresh", async (t) => {
	const f = moduleFixture(t, 'let n = 0; export default { statuses: { "example-work": text => `first:${text}:${++n}` } };');
	const first = await loadModules(["./module #1.mjs"], f.configFile);
	const draw = (loaded) => loaded.statuses.get("example-work").handler("ready", CONTEXT);
	assert.equal(draw(first), "first:ready:1");
	assert.equal(draw(first), "first:ready:2");
	assert.equal(draw(await loadModules([f.file], f.configFile)), "first:ready:1", "a reload re-evaluates the module");
	writeFileSync(f.file, 'export default { statuses: { "example-work": text => `second:${text}` } };');
	const home = process.env.HOME;
	try {
		process.env.HOME = f.root;
		assert.equal(draw(await loadModules(["~/module #1.mjs"], f.configFile)), "second:ready");
	} finally {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
	}
	assert.deepEqual((await loadModules([], f.configFile)).modules, []);
});

test("bad paths, syntax, exports and conflicting statuses fail at load, not render", async (t) => {
	const f = moduleFixture(t, "export default {};");
	await assert.rejects(loadModules(["./missing.mjs"], f.configFile));
	for (const source of [
		"export default {", "export const unrelated = 1;", "export default null;", "export default [];",
		'export default { format: {} };', 'export default { statuses: [] };', 'export default { events: "x" };',
		'export default { statuses: { "": () => "x" } };', 'export default { events: { "example:tick": "not a function" } };',
	]) {
		writeFileSync(f.file, source);
		await assert.rejects(loadModules([f.file], f.configFile), undefined, source);
	}
	writeFileSync(f.file, 'export default { statuses: { "example-work": () => "x" } };');
	const other = join(f.root, "other.mjs");
	writeFileSync(other, 'export default { statuses: { "example-work": () => "y" }, events: { "example:tick": () => {} } };');
	await assert.rejects(loadModules([f.file, other], f.configFile), /module #1\.mjs and other\.mjs both draw status "example-work"/);
	writeFileSync(other, 'export default { events: { "example:tick": () => {} } };');
	assert.equal((await loadModules([f.file, other], f.configFile)).modules.length, 2, "two modules may share an event");
});

test("status text is sanitized both ways, with fallback, hiding and unpublished keys", async () => {
	let received;
	let receivedContext;
	const loaded = {
		modules: [],
		statuses: new Map(Object.entries({
			normal: (text, context) => { received = text; receivedContext = context; return "\x1b[2Jshort\ntext\x1b[31m"; },
			decline: () => undefined, null: () => null, hide: () => "",
			throws: () => { throw new Error("bad display rule"); }, invalid: () => 42,
			async: async () => { throw new Error("async handlers are unsupported"); },
			fallback: (text) => text ?? "made from events",
		}).map(([key, handler]) => [key, { module: "fixture.mjs", handler }])),
	};
	assert.equal(statusText("normal", "\x1b[34m original\ttext \x1b[0m", "normalized", loaded, CONTEXT), "short text");
	assert.equal(received, "original text");
	assert.deepEqual(receivedContext, CONTEXT);
	for (const key of ["missing", "decline", "null", "throws", "invalid", "async"]) {
		assert.equal(statusText(key, "\x1b[31moriginal\x1b[0m", "normalized", loaded, CONTEXT), "original", key);
	}
	assert.equal(statusText("hide", "original", "normalized", loaded, CONTEXT), "");
	assert.equal(statusText("missing", undefined, "normalized", loaded, CONTEXT), "");
	assert.equal(statusText("fallback", undefined, "normalized", loaded, CONTEXT), "made from events", "a module can draw an unpublished key");
	assert.equal(statusText("fallback", "\n ", "normalized", loaded, CONTEXT), "made from events", "blank text counts as unpublished");
	assert.equal(statusText("decline", undefined, "normalized", loaded, CONTEXT), "", "declining an unpublished key shows nothing");
	const producer = statusText("normal", "original", "producer", loaded, CONTEXT);
	assert.equal(plain(producer), "short text");
	assert.match(producer, /\x1b\[31m\x1b\[0m$/);
	assert.equal(statusText("normal", "original", "normalized", NO_MODULES, CONTEXT), "original");
	await Promise.resolve();
});

test("the footer draws a module's selected status, then applies color and width", async (t) => {
	const dirs = scratch({ config: { modules: ["./work.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "work.mjs", 'export default { statuses: { "example-work": text => text === "a verbose label" ? "short label" : undefined } };');
	const theme = testTheme();
	const host = await start({ dirs, theme, statuses: { "example-work": "a verbose label" } });
	try {
		assert.match(bottom(host), /── short label ──╯$/);
		assert.ok(host.renderEditor(120).at(-2).includes(theme.fg("syntaxFunction", "short label")));
		assert.equal(host.state.statuses.get("example-work"), "a verbose label", "the producer and other consumers keep the original");
		host.ctx.ui.setStatus("example-work", "unknown label");
		assert.match(bottom(host), /── unknown label ──╯$/);
		writeFileSync(dirs.configFile, JSON.stringify({ modules: ["./work.mjs"], layout: { ...PINNED, bottomRight: [{ remainingStatuses: true, color: "syntaxFunction", maxWidth: 7 }] } }));
		await host.command("reload");
		host.ctx.ui.setStatus("example-work", "a verbose label");
		assert.match(bottom(host), /── short … ──╯$/, "remaining statuses are drawn by modules too");
		for (const width of [120, 60, 30, 24, 23]) {
			const rows = width < 24 ? host.renderFooter(width) : host.renderEditor(width);
			for (const row of rows) assert.ok(visibleWidth(row) <= width);
		}
	} finally {
		await host.shutdown();
	}
});

test("a module's events update its state and redraw the footer, with the session as context", async (t) => {
	const dirs = scratch({ config: { modules: ["./counter.mjs", "./session.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "counter.mjs", COUNTER);
	writeModule(dirs, "session.mjs", 'export let seen; export default { events: { "example:tick": (data, context) => { globalThis.footerModuleSeen = [data, context]; } } };');
	const host = await start({ dirs });
	try {
		assert.match(bottom(host), /── none ×0 ──╯$/, "a module can draw a key nothing has published");
		const before = host.state.renderRequests;
		await host.publish("example:tick", { n: 1 });
		assert.match(bottom(host), /── none ×1 ──╯$/);
		assert.ok(host.state.renderRequests > before, "an event asks for a redraw");
		assert.deepEqual(globalThis.footerModuleSeen, [{ n: 1 }, { sessionId: "session-1" }], "both modules hear the event");
		host.ctx.ui.setStatus("example-work", "ready");
		await host.publish("example:tick");
		assert.match(bottom(host), /── ready ×2 ──╯$/);
		await host.publish("example:unrelated");
		assert.match(bottom(host), /── ready ×2 ──╯$/);
	} finally {
		delete globalThis.footerModuleSeen;
		await host.shutdown();
	}
});

test("a failing event handler stays quiet and still redraws", async (t) => {
	const dirs = scratch({ config: { modules: ["./broken.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "broken.mjs", `
let count = 0;
export default {
	events: { "example:tick": () => { count++; throw new Error("bad handler"); }, "example:async": async () => { throw new Error("bad async handler"); } },
	statuses: { "example-work": () => \`×\${count}\` },
};`);
	const host = await start({ dirs });
	const errors = [];
	const consoleError = console.error;
	console.error = (...args) => errors.push(args);
	try {
		await host.publish("example:tick");
		await host.publish("example:async");
		assert.deepEqual(errors, [], "nothing is printed over the TUI");
		assert.match(bottom(host), /── ×1 ──╯$/);
	} finally {
		console.error = consoleError;
		await host.shutdown();
	}
});

test("reload swaps subscriptions, keeps the last valid modules on failure, and shutdown unsubscribes", async (t) => {
	const dirs = scratch({ config: { modules: ["./counter.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "counter.mjs", COUNTER);
	const host = await start({ dirs });
	try {
		await host.publish("example:tick");
		assert.match(bottom(host), /── none ×1 ──╯$/);
		await host.command("reload");
		assert.match(bottom(host), /── none ×0 ──╯$/, "a reload starts the module fresh");
		await host.publish("example:tick");
		assert.match(bottom(host), /── none ×1 ──╯$/, "the old module's subscription is gone, so one event counts once");

		writeModule(dirs, "counter.mjs", "export default {");
		await host.command("reload");
		assert.match(host.state.notifications.at(-2).message, /kept the previous modules/);
		await host.publish("example:tick");
		assert.match(bottom(host), /── none ×2 ──╯$/, "the kept module still listens");

		writeFileSync(dirs.configFile, JSON.stringify({ modules: "./counter.mjs", layout: PINNED }));
		await host.command("reload");
		assert.match(host.state.notifications.at(-2).message, /"modules" must be a list/);
		assert.match(bottom(host), /── none ×2 ──╯$/);

		writeFileSync(dirs.configFile, JSON.stringify({ modules: null, layout: PINNED }));
		await host.command("reload");
		assert.match(bottom(host), /^╰─+╯$/, "without modules, an unpublished status shows nothing");
		host.ctx.ui.setStatus("example-work", "original");
		assert.match(bottom(host), /── original ──╯$/);
	} finally {
		await host.shutdown();
	}
});

test("shutdown removes the modules' subscriptions", async (t) => {
	const dirs = scratch({ config: { modules: ["./listener.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "listener.mjs", 'export default { events: { "example:tick": () => { globalThis.footerModuleTicks = (globalThis.footerModuleTicks ?? 0) + 1; } } };');
	const host = await start({ dirs });
	try {
		await host.publish("example:tick");
		await host.shutdown();
		await host.publish("example:tick");
		assert.equal(globalThis.footerModuleTicks, 1);
	} finally {
		delete globalThis.footerModuleTicks;
	}
});

test("a failed startup module warns and leaves ordinary statuses available", async (t) => {
	const host = await start({ config: { modules: ["./missing.mjs"], layout: PINNED }, statuses: { "example-work": "original" } });
	t.after(() => rmSync(host.dirs.root, { recursive: true, force: true }));
	try {
		assert.equal(host.state.notifications.length, 1);
		assert.match(host.state.notifications[0].message, /running without modules/);
		assert.match(bottom(host), /── original ──╯$/);
	} finally {
		await host.shutdown();
	}
});

test("the old statusFormatters setting is reported, not read", async (t) => {
	const dirs = scratch({ config: { statusFormatters: "./formatters.mjs", layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "formatters.mjs", 'export default { "example-work": () => "formatted" };');
	const host = await start({ dirs, statuses: { "example-work": "original" } });
	try {
		assert.match(host.state.notifications[0].message, /"statusFormatters" is no longer read; list footer modules under "modules"/);
		assert.match(bottom(host), /── original ──╯$/);
	} finally {
		await host.shutdown();
	}
});

test("/context-footer statuses names the module that draws a key", async (t) => {
	const dirs = scratch({ config: { modules: ["./counter.mjs"], layout: PINNED } });
	t.after(() => rmSync(dirs.root, { recursive: true, force: true }));
	writeModule(dirs, "counter.mjs", COUNTER);
	const host = await start({ dirs });
	try {
		await host.command("statuses");
		assert.match(host.state.notifications.at(-1).message, /"example-work" — status item in bottomRight, drawn by module counter\.mjs/);
	} finally {
		await host.shutdown();
	}
});
