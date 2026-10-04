import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fakeTheme, plain, scratch, startFooter } from "./harness.mjs";

let loads = 0;
/** A fresh copy of the extension per test, so no module state carries over. */
const start = (options) => startFooter(new URL(`./index.ts?footer=${loads++}`, import.meta.url).href, options);

const topRule = (lines) => plain(lines[1]);
const bottomRule = (lines) => plain(lines.at(-2));

async function waitFor(predicate, ms = 2_000) {
	for (const end = Date.now() + ms; Date.now() < end; await delay(20)) if (predicate()) return true;
	return predicate();
}
const ghCalls = (host) => (existsSync(host.dirs.ghLog) ? readFileSync(host.dirs.ghLog, "utf8").split("\n").filter(Boolean) : []);

test("built-in items are selected, omitted and reordered by configuration alone", async () => {
	const host = await start({
		config: { layout: { topLeft: ["tokens", "model"], topRight: [], bottomLeft: [], bottomRight: ["directory"] } },
	});
	try {
		const lines = host.renderEditor(100);
		assert.match(topRule(lines), /^╭── ⇡1\.7k ⇣300 ── 󰚌 Synthetic Model ─+╮$/);
		assert.match(bottomRule(lines), /^╰─+ \S demo-repo ──╯$/);
		assert.doesNotMatch(lines.map(plain).join("\n"), /thinking|feature\/demo/);
	} finally {
		await host.shutdown();
	}
});

test("an empty region keeps its border", async () => {
	const host = await start({ config: { layout: { bottomLeft: [], bottomRight: [] } } });
	try {
		const lines = host.renderEditor(60);
		assert.equal(bottomRule(lines), `╰${"─".repeat(58)}╯`);
	} finally {
		await host.shutdown();
	}
});

test("plain mode uses the same selection and order", async () => {
	const host = await start({ config: { layout: { topLeft: ["context", "model"], topRight: [], bottomLeft: [], bottomRight: ["tokens"] } } });
	try {
		const rows = host.renderFooter(23).map(plain);
		// The context item fills the row, so the model after it is hidden.
		assert.match(rows[0], /^\S ░░░░░░░░ 5%\/200k$/);
		assert.equal(rows[1], "⇡1.7k ⇣300");
		for (const row of host.renderFooter(23)) assert.ok(visibleWidth(row) <= 23);
	} finally {
		await host.shutdown();
	}
});

test("an invalid layout at startup warns once and uses the default", async () => {
	const host = await start({ config: { layout: { topLeft: ["cost"] } } });
	try {
		assert.equal(host.state.notifications.length, 1);
		assert.match(host.state.notifications[0].message, /unknown built-in item "cost".*default layout/);
		assert.match(topRule(host.renderEditor(120)), /Synthetic Model ── thinking:high/);
	} finally {
		await host.shutdown();
	}
});

test("configuration reload applies a valid layout and keeps the last valid one otherwise", async () => {
	const host = await start({ config: { layout: { topLeft: ["model"] } } });
	try {
		assert.doesNotMatch(topRule(host.renderEditor(120)), /thinking/);

		writeFileSync(host.dirs.configFile, JSON.stringify({ layout: { topLeft: ["thinking", "model"] } }));
		await host.command("reload");
		assert.match(topRule(host.renderEditor(120)), /^╭── thinking:high ── 󰚌 Synthetic Model/);

		writeFileSync(host.dirs.configFile, JSON.stringify({ layout: { topLeft: ["model", "model"] } }));
		await host.command("reload");
		assert.match(host.state.notifications.at(-2).message, /already selected.*Kept the previous layout/);
		assert.match(topRule(host.renderEditor(120)), /^╭── thinking:high ── 󰚌 Synthetic Model/);

		writeFileSync(host.dirs.configFile, "{ half-edited");
		await host.command("reload");
		assert.match(host.state.notifications.at(-2).message, /not valid JSON.*Kept the previous layout/);
		assert.match(topRule(host.renderEditor(120)), /^╭── thinking:high ── 󰚌 Synthetic Model/);
	} finally {
		await host.shutdown();
	}
});

test("an unselected pull-request item never runs gh", async () => {
	const layout = { bottomRight: ["branch", "tokens"] };
	const host = await start({ config: { layout }, pullRequest: { number: 4, url: "https://example.com/pull/4" } });
	try {
		host.renderEditor(120);
		host.changeBranch("other");
		await delay(200);
		assert.deepEqual(ghCalls(host), []);
	} finally {
		await host.shutdown();
	}
});

test("a disabled footer never runs gh, and enabling it starts the lookup", async () => {
	const dirs = scratch({ pullRequest: { number: 4, url: "https://example.com/pull/4" } });
	// Disable before anything else: the first lookup has already started, so
	// wait for it, clear the log and then check that nothing more runs.
	const host = await start({ dirs });
	await waitFor(() => ghCalls(host).length === 1);
	writeFileSync(dirs.ghLog, "");
	try {
		await host.command("off");
		assert.equal(host.hasFooter(), false);
		host.changeBranch("other");
		await delay(200);
		assert.deepEqual(ghCalls(host), []);

		await host.command("on");
		assert.ok(await waitFor(() => ghCalls(host).length === 1));
		assert.match(ghCalls(host)[0], /pr view other --json number,url$/);
	} finally {
		await host.shutdown();
	}
});

test("a selected pull-request item is looked up even while clipped, and shown when there is room", async () => {
	const host = await start({ pullRequest: { number: 4, url: "https://example.com/pull/4" } });
	try {
		host.renderEditor(26);
		assert.ok(await waitFor(() => host.state.renderRequests > 0));
		assert.deepEqual(ghCalls(host), [`${host.dirs.cwd} pr view feature/demo --json number,url`]);
		assert.doesNotMatch(bottomRule(host.renderEditor(26)), /#4/);
		const wide = host.renderEditor(120);
		assert.match(bottomRule(wide), /feature\/demo ── #4 ──/);
		assert.ok(wide.at(-2).includes("\x1b]8;;https://example.com/pull/4\x07"));

		// Another branch never shows the first branch's pull request.
		host.changeBranch("other");
		assert.doesNotMatch(bottomRule(host.renderEditor(120)), /#4/);
	} finally {
		await host.shutdown();
	}
});

test("configuration writes keep unrelated keys and follow a symlinked file", async () => {
	const dirs = scratch();
	const shared = join(dirs.root, "dotfiles", "config.json");
	mkdirSync(join(dirs.root, "dotfiles"));
	writeFileSync(shared, JSON.stringify({ layout: { topLeft: ["model"] }, unrelated: { keep: true } }));
	symlinkSync(shared, dirs.configFile);
	const host = await start({ dirs });
	try {
		await host.command("host on");
		const written = JSON.parse(readFileSync(shared, "utf8"));
		assert.deepEqual(written, { layout: { topLeft: ["model"] }, unrelated: { keep: true }, hostname: { show: true } });

		writeFileSync(shared, "{ half-edited");
		await host.command("animate off");
		assert.equal(readFileSync(shared, "utf8"), "{ half-edited");
	} finally {
		await host.shutdown();
	}
});

test("the shimmer ticker runs only while the thinking item is on screen", async () => {
	const host = await start({ thinkingLevel: "max" });
	try {
		host.renderEditor(120);
		const before = host.state.renderRequests;
		await delay(250);
		assert.ok(host.state.renderRequests - before >= 2, "ticking while visible");

		// Clipped out of the upper rule: no ticker.
		host.state.sessionName = "a session name wide enough to push everything else out";
		host.renderEditor(60);
		let settled = host.state.renderRequests;
		await delay(250);
		assert.equal(host.state.renderRequests, settled, "still while clipped");

		// Unselected: no ticker either.
		host.state.sessionName = null;
		writeFileSync(host.dirs.configFile, JSON.stringify({ layout: { topLeft: ["model"] } }));
		await host.command("reload");
		host.renderEditor(120);
		settled = host.state.renderRequests;
		await delay(250);
		assert.equal(host.state.renderRequests, settled, "still while unselected");

		// Plain mode and animation off never tick.
		writeFileSync(host.dirs.configFile, "{}");
		await host.command("reload");
		host.renderEditor(20);
		settled = host.state.renderRequests;
		await delay(250);
		assert.equal(host.state.renderRequests, settled, "still in plain mode");
		await host.command("animate off");
		host.renderEditor(120);
		settled = host.state.renderRequests;
		await delay(250);
		assert.equal(host.state.renderRequests, settled, "still with animation off");
	} finally {
		await host.shutdown();
	}
});

test("shutdown stops the ticker", async () => {
	const host = await start({ thinkingLevel: "max" });
	host.renderEditor(120);
	await host.shutdown();
	const settled = host.state.renderRequests;
	await delay(250);
	assert.equal(host.state.renderRequests, settled);
});

test("a second session_start does not wrap the editor twice", async () => {
	const host = await start({});
	try {
		const once = host.renderEditor(80);
		await host.emit("session_start", { reason: "startup" });
		assert.deepEqual(host.renderEditor(80), once);
	} finally {
		await host.shutdown();
	}
});

test("the footer disabled leaves pi's editor rows alone", async () => {
	const host = await start({});
	try {
		await host.command("off");
		assert.deepEqual(host.renderEditor(40).map(plain), ["─".repeat(40), "hello".padEnd(40), "─".repeat(40)]);
	} finally {
		await host.shutdown();
	}
});

test("token totals follow new entries and the current session", async () => {
	const host = await start({});
	try {
		assert.match(bottomRule(host.renderEditor(120)), /⇡1\.7k ⇣300/);
		host.state.entries = [...host.state.entries, {
			type: "compaction", id: "c1", parentId: "a1", timestamp: "", summary: "", firstKeptEntryId: "a1", tokensBefore: 0,
			usage: { input: 2000, output: 700, cacheRead: 0, cacheWrite: 0, totalTokens: 2700, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}];
		host.state.leafId = "c1";
		assert.match(bottomRule(host.renderEditor(120)), /⇡3\.7k ⇣1\.0k/);
	} finally {
		await host.shutdown();
	}
});

test("a status color the current theme lacks falls back instead of crashing the render", async () => {
	const host = await start({
		theme: fakeTheme(["chartreuse"]),
		config: { layout: { bottomRight: [{ status: "x", color: "chartreuse" }] } },
		statuses: { x: "shown" },
	});
	try {
		assert.equal(host.state.notifications.length, 0);
		host.ctx.ui.theme = fakeTheme();
		assert.match(bottomRule(host.renderEditor(80)), /shown ──╯$/);
	} finally {
		await host.shutdown();
	}
});
