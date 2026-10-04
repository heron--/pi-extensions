import assert from "node:assert/strict";
import test from "node:test";
import { assistantEntry, plain, startFooter, usageOf } from "./harness.mjs";
import { createTokenTotalsCache, tokenTotals } from "./items.ts";

const entry = (id, parentId, fields) => ({ id, parentId, timestamp: "2026-01-01T00:00:00Z", ...fields });

/**
 * A session with a branch point: a1 → (b1 abandoned) and a1 → c1, plus a tool
 * that reported its own usage, a compaction and a branch summary.
 */
const SESSION = [
	entry("u1", null, { type: "message", message: { role: "user", content: "hi", timestamp: 0 } }),
	{ ...assistantEntry("a1", usageOf(100, 10, { cacheRead: 50, cacheWrite: 5 })), parentId: "u1" },
	{ ...assistantEntry("b1", usageOf(1000, 100)), parentId: "a1" },
	{ ...assistantEntry("c1", usageOf(200, 20)), parentId: "a1" },
	entry("t1", "c1", { type: "message", message: { role: "toolResult", toolCallId: "x", toolName: "sub", content: [], isError: false, timestamp: 0, usage: usageOf(300, 30) } }),
	entry("t2", "t1", { type: "message", message: { role: "toolResult", toolCallId: "y", toolName: "read", content: [], isError: false, timestamp: 0 } }),
	entry("k1", "t2", { type: "compaction", summary: "", firstKeptEntryId: "c1", tokensBefore: 0, usage: usageOf(400, 40) }),
	entry("s1", "k1", { type: "branch_summary", fromId: "b1", summary: "", usage: usageOf(500, 50) }),
	entry("m1", "s1", { type: "custom", customType: "other", data: {} }),
];

test("token totals cover the whole session, abandoned branches included", () => {
	// Input is cache-inclusive: 100+50+5, then 1000 (abandoned), 200, 300 (tool),
	// 400 (compaction) and 500 (branch summary); the user, tool-without-usage and
	// custom entries add nothing.
	assert.deepEqual(tokenTotals(SESSION), { input: 2555, output: 10 + 100 + 20 + 30 + 40 + 50 });
});

test("the cache recomputes when the leaf moves and not otherwise", () => {
	let reads = 0;
	const manager = {
		leaf: "a1",
		getSessionId: () => "s",
		getLeafId() {
			return this.leaf;
		},
		getEntries() {
			reads++;
			return SESSION.slice(0, this.leaf === "a1" ? 2 : SESSION.length);
		},
	};
	const totals = createTokenTotalsCache();
	assert.deepEqual(totals(manager), { input: 155, output: 10 });
	totals(manager);
	assert.equal(reads, 1);
	manager.leaf = "m1";
	assert.equal(totals(manager).input, 2555);
	assert.equal(reads, 2);
});

test("a reported cost appears only as a selected status item, as published", async () => {
	let loads = 0;
	const start = (options) => startFooter(new URL(`./index.ts?tokens=${loads++}`, import.meta.url).href, options);
	const bottom = (host) => plain(host.renderEditor(120).at(-2));

	const unselected = await start({ statuses: { "example-session-cost": "$4.20" } });
	try {
		assert.doesNotMatch(bottom(unselected), /\$/, "the default layout adopts no cost");
	} finally {
		await unselected.shutdown();
	}

	const selected = await start({
		config: { layout: { bottomRight: ["tokens", { status: "example-session-cost", color: "success" }] } },
		// Recorded usage with a cost pi recorded: still no footer-computed figure.
		entries: [assistantEntry("a1", usageOf(1200, 300, { cacheRead: 500, cost: 9.99 }))],
	});
	try {
		assert.match(bottom(selected), /⇡1\.7k ⇣300 ──╯$/, "unpublished: no cost, no invented zero");
		selected.ctx.ui.setStatus("example-session-cost", "$0.00");
		assert.match(bottom(selected), /⇡1\.7k ⇣300 ── \$0\.00 ──╯$/);
		selected.ctx.ui.setStatus("example-session-cost", "cost unavailable");
		assert.match(bottom(selected), /── cost unavailable ──╯$/);
		selected.ctx.ui.setStatus("example-session-cost", undefined);
		assert.doesNotMatch(bottom(selected), /\$/);
	} finally {
		await selected.shutdown();
	}
});

test("the footer source computes, prices and formats no cost", async () => {
	const { readFileSync, readdirSync } = await import("node:fs");
	const dir = new URL("./", import.meta.url);
	for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
		assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /cost|pric/i, name);
	}
});
