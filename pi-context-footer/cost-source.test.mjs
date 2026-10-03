import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COST_REQUEST_EVENT, COST_REQUEST_TIMEOUT_MS, CostSourcePoller, parseCostSourceSettings } from "./cost-source.ts";
import extension from "./index.ts";

function harness(t) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const requests = [];
	let updates = 0;
	const events = { emit(channel, request) { assert.equal(channel, COST_REQUEST_EVENT); requests.push(request); } };
	const poller = new CostSourcePoller(events, { id: "meter", refreshSeconds: 60 }, "session-a", () => updates++);
	t.after(() => poller.stop());
	return { poller, requests, updates: () => updates };
}

test("source is opt-in and settings are bounded", () => {
	assert.equal(parseCostSourceSettings(undefined), null);
	assert.equal(parseCostSourceSettings(null), null);
	assert.deepEqual(parseCostSourceSettings({ id: "meter" }), { id: "meter", refreshSeconds: 60 });
	for (const value of ["meter", [], {}, { id: "local" }, { id: "bad id" }, { id: "meter", refreshSeconds: 0 }, { id: "meter", refreshSeconds: Infinity }, { id: "meter", refreshSeconds: 3601 }]) {
		assert.throws(() => parseCostSourceSettings(value));
	}
});

test("first fetch is deferred, zero is valid, and reads never poll", (t) => {
	const h = harness(t);
	h.poller.start(); h.poller.start();
	assert.equal(h.requests.length, 0);
	t.mock.timers.tick(0);
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].sessionId, "session-a");
	assert.equal(h.requests[0].source, "meter");
	const snapshot = { costUsd: 0 };
	h.requests[0].respond(snapshot);
	snapshot.costUsd = 99;
	assert.deepEqual(h.poller.getSnapshot(), { costUsd: 0, partial: false });
	for (let i = 0; i < 100; i++) h.poller.getSnapshot();
	t.mock.timers.tick(59_999);
	assert.equal(h.requests.length, 1);
	t.mock.timers.tick(1);
	assert.equal(h.requests.length, 2);
	h.requests[1].respond({ costUsd: 1.25, partial: true });
	assert.deepEqual(h.poller.getSnapshot(), { costUsd: 1.25, partial: true });
	assert.equal(h.updates(), 2);
});

test("unavailable values fall back, errors and timeouts keep last success", (t) => {
	const h = harness(t);
	h.poller.start(); t.mock.timers.tick(0);
	h.requests[0].respond({ costUsd: 12 });
	t.mock.timers.tick(60_000);
	for (const costUsd of [NaN, Infinity, -1, "12", undefined]) h.requests[1].respond({ costUsd });
	t.mock.timers.tick(COST_REQUEST_TIMEOUT_MS);
	assert.equal(h.requests[1].signal.aborted, true);
	assert.equal(h.poller.getSnapshot().costUsd, 12);
	h.requests[1].respond({ costUsd: 42 });
	assert.equal(h.poller.getSnapshot().costUsd, 12);
	t.mock.timers.tick(60_000);
	h.requests[2].respond({ costUsd: null });
	assert.equal(h.poller.getSnapshot().costUsd, null);
});

test("stop clears the cache, aborts requests and ignores late responses", (t) => {
	const h = harness(t);
	h.poller.start(); t.mock.timers.tick(0);
	h.poller.stop();
	assert.equal(h.requests[0].signal.aborted, true);
	h.requests[0].respond({ costUsd: 99 });
	assert.equal(h.poller.getSnapshot(), null);
	t.mock.timers.tick(1_000_000);
	assert.equal(h.requests.length, 1);
	h.poller.start(); t.mock.timers.tick(0);
	h.requests[0].respond({ costUsd: 88 });
	assert.equal(h.poller.getSnapshot(), null);
	h.requests[1].respond({ costUsd: 1 });
	assert.equal(h.poller.getSnapshot().costUsd, 1);
});

test("throwing providers do not escape the loop", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let requests = 0;
	const poller = new CostSourcePoller({ emit() { requests++; throw new Error("broken"); } }, { id: "meter", refreshSeconds: 60 }, "a", () => {});
	t.after(() => poller.stop());
	poller.start(); t.mock.timers.tick(0); t.mock.timers.tick(60_000);
	assert.equal(requests, 2);
	assert.equal(poller.getSnapshot(), null);
});

test("footer integration renders the override in frame and narrow fallback, resets on new sessions and opt-out", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const agent = mkdtempSync(join(tmpdir(), "footer-cost-test-"));
	const oldAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => { if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent; rmSync(agent, { recursive: true, force: true }); });
	mkdirSync(join(agent, "pi-context-footer"));
	writeFileSync(join(agent, "pi-context-footer/config.json"), JSON.stringify({ costSource: { id: "meter" } }));
	const bus = new EventEmitter();
	const requests = [];
	bus.on(COST_REQUEST_EVENT, request => requests.push(request));
	const handlers = new Map(), commands = new Map();
	const pi = { events: { emit: (event, data) => bus.emit(event, data) }, on: (event, handler) => handlers.set(event, handler), registerCommand: (name, command) => commands.set(name, command) };
	let editorFactory, footer, sessionId = "a", renders = 0;
	const tui = { requestRender() { renders++; } };
	const theme = { fg: (_color, text) => text, getBgAnsi: () => "\x1b[49m" };
	const provider = { getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
	const ctx = { mode: "tui", ui: { theme, notify() {}, getEditorComponent: () => () => ({ render: width => ["─".repeat(width), " ".repeat(width), "─".repeat(width)], getText: () => "" }),
		setEditorComponent(factory) { editorFactory = factory; },
		setFooter(factory) { footer?.dispose(); footer = factory?.(tui, theme, provider); } },
		sessionManager: { getSessionId: () => sessionId, getCwd: () => "/tmp/demo", getSessionName: () => undefined,
			getEntries: () => [{ type: "message", message: { role: "assistant", model: "unknown", provider: "fixture", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 7 } } } }] },
		getContextUsage: () => null };
	extension(pi);
	t.after(() => handlers.get("session_shutdown")({}, ctx));
	await handlers.get("session_start")({}, ctx);
	const editor = editorFactory(tui, {}, {});
	assert.match(editor.render(120).join("\n"), /\$7\.00/);
	t.mock.timers.tick(0);
	requests[0].respond({ costUsd: 3, partial: true });
	assert.match(editor.render(120).join("\n"), /\$3\.00 \(partial\)/);
	assert.doesNotMatch(editor.render(120).join("\n"), /\$7\.00/);
	assert.match(footer.render(23).join("\n"), /\$3\.00/);
	assert.ok(renders > 0);
	sessionId = "b";
	const nextContext = { ...ctx, model: { name: "Replacement context" }, sessionManager: {
		...ctx.sessionManager, getEntries: () => [{ type: "message", message: {
			role: "assistant", model: "unknown", provider: "fixture",
			usage: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } },
		} }],
	} };
	await handlers.get("session_start")({}, nextContext);
	t.mock.timers.tick(0);
	assert.equal(requests.at(-1).sessionId, "b");
	requests[0].respond({ costUsd: 99 });
	assert.match(editor.render(120).join("\n"), /\$9\.00/);
	assert.match(editor.render(120).join("\n"), /Replacement context/);
	const pending = requests.at(-1);
	await commands.get("context-footer").handler("off", nextContext);
	assert.equal(pending.signal.aborted, true);
	await commands.get("context-footer").handler("on", nextContext);
	t.mock.timers.tick(0);
	requests.at(-1).respond({ costUsd: 0 });
	assert.match(editor.render(120).join("\n"), /\$0\.00/);
	await commands.get("context-footer").handler("cost local", nextContext);
	assert.match(editor.render(120).join("\n"), /\$9\.00/);
	const count = requests.length;
	t.mock.timers.tick(1_000_000);
	assert.equal(requests.length, count);
});
