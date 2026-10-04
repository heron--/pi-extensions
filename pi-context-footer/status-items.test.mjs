import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plain, startFooter } from "./harness.mjs";

let loads = 0;
const start = (options) => startFooter(new URL(`./index.ts?status=${loads++}`, import.meta.url).href, options);
const top = (host, width = 120) => plain(host.renderEditor(width)[1]);
const bottom = (host, width = 120) => plain(host.renderEditor(width).at(-2));

/** A pinned layout: all four regions given, no remaining-statuses item. */
const PINNED = {
	topLeft: ["model"],
	topRight: [{ status: "example-cost", color: "success" }],
	bottomLeft: [],
	bottomRight: ["tokens", { status: "zz-last" }, { status: "aa-first" }],
};

test("a synthetic producer's status is selected, placed and updated by configuration alone", async () => {
	const host = await start({ config: { layout: PINNED } });
	try {
		assert.match(top(host), /^╭── 󰚌 Synthetic Model ─+╮$/, "selected but unpublished: nothing, not even a separator");

		host.ctx.ui.setStatus("example-cost", "$0.00");
		assert.match(top(host), /── \$0\.00 ──╮$/, "zero is ordinary text");
		host.ctx.ui.setStatus("example-cost", "\x1b[31m$1.25 (stale 5m)\x1b[0m");
		assert.match(top(host), /── \$1\.25 \(stale 5m\) ──╮$/);
		host.ctx.ui.setStatus("example-cost", "error: gateway unavailable");
		assert.match(top(host), /── error: gateway unavailable ──╮$/);
		host.ctx.ui.setStatus("example-cost", undefined);
		assert.match(top(host), /^╭── 󰚌 Synthetic Model ─+╮$/, "cleared: nothing");
		host.ctx.ui.setStatus("example-cost", "  \n ");
		assert.match(top(host), /^╭── 󰚌 Synthetic Model ─+╮$/, "blank: nothing");
	} finally {
		await host.shutdown();
	}
});

test("layout order holds whatever order statuses were published in", async () => {
	const host = await start({ config: { layout: PINNED } });
	try {
		host.ctx.ui.setStatus("aa-first", "A");
		host.ctx.ui.setStatus("zz-last", "Z");
		assert.match(bottom(host), /⇡1\.7k ⇣300 ── Z ── A ──╯$/);
		host.ctx.ui.setStatus("zz-last", undefined);
		host.ctx.ui.setStatus("zz-last", "Z2");
		assert.match(bottom(host), /⇡1\.7k ⇣300 ── Z2 ── A ──╯$/);
		host.ctx.ui.setStatus("zz-last", "");
		assert.match(bottom(host), /⇡1\.7k ⇣300 ── A ──╯$/, "no empty separator");
	} finally {
		await host.shutdown();
	}
});

test("a pinned layout ignores an unrelated status; a remaining-statuses item shows it in key order", async () => {
	const pinned = await start({ config: { layout: PINNED }, statuses: { "aa-first": "A" } });
	try {
		const before = pinned.renderEditor(120);
		pinned.ctx.ui.setStatus("unrelated", "NEW");
		assert.deepEqual(pinned.renderEditor(120), before);
	} finally {
		await pinned.shutdown();
	}

	const open = await start({
		config: { layout: { ...PINNED, bottomLeft: [{ remainingStatuses: true, maxWidth: 12 }] } },
		statuses: { "aa-first": "A" },
	});
	try {
		assert.match(bottom(open), /^╰──────/, "nothing remaining yet");
		open.ctx.ui.setStatus("mm", "middle");
		open.ctx.ui.setStatus("bb", "second");
		const row = bottom(open);
		// Key order (bb, mm), the exact-key item not repeated, and the aggregate limit.
		assert.match(row, /^╰── second midd… ─/);
		assert.equal((row.match(/\bA\b/g) ?? []).length, 1);
	} finally {
		await open.shutdown();
	}
});

test("presentation: normalized repaints, producer keeps styling, both obey the width limit", async () => {
	const theme = (await import("./harness.mjs")).fakeTheme();
	const warning = theme.fg("warning", "x").split("x")[0];
	const host = await start({
		config: {
			layout: {
				...PINNED,
				bottomRight: [
					{ status: "normal", color: "warning", maxWidth: 8 },
					{ status: "producer", presentation: "producer" },
				],
			},
		},
		statuses: { normal: "\x1b[35mrepainted text\x1b[0m", producer: "\x1b[35mkept\x1b[0m" },
	});
	try {
		const row = host.renderEditor(120).at(-2);
		assert.match(plain(row), /── repaint… ── kept ──╯$/);
		assert.ok(row.includes(`${warning}repaint`), "normalized uses the configured color");
		assert.ok(row.includes("\x1b[35mkept\x1b[0m"), "producer keeps its own color");
		assert.ok(!row.includes("\x1b[35mrepaint"), "normalized drops the producer's color");
	} finally {
		await host.shutdown();
	}
});

test("hostile status text cannot break the frame at any width", async () => {
	const host = await start({
		config: { layout: { ...PINNED, bottomRight: [{ status: "hostile", presentation: "producer" }] } },
		statuses: { hostile: "\x1b[2J\x1b[H\x1b]0;title\x07line\none\x1b[41m 👍🏽 日本語 \x1b]8;;https://example.com\x07link" },
	});
	try {
		for (const width of [120, 60, 30, 24]) {
			for (const line of host.renderEditor(width)) {
				assert.ok(visibleWidth(line) <= width);
				assert.doesNotMatch(line, /\x1b\[2J|\x1b\[H|\x1b\]0;/);
			}
		}
		assert.match(bottom(host), /line one 👍🏽 日本語 link ──╯$/);
	} finally {
		await host.shutdown();
	}
});

test("plain mode shows the same status items", async () => {
	const host = await start({ config: { layout: PINNED }, statuses: { "example-cost": "$2.00", "aa-first": "A" } });
	try {
		const rows = host.renderFooter(23).map(plain);
		assert.match(rows[0], /^󰚌 Synthetic Model/);
		host.ctx.ui.setStatus("example-cost", undefined);
		host.ctx.ui.setStatus("zz-last", "Z");
		assert.match(plain(host.renderFooter(23)[1]), /^⇡1\.7k ⇣300  ──  Z  ──…$|^⇡1\.7k ⇣300  ──  Z$/);
	} finally {
		await host.shutdown();
	}
});

test("/context-footer statuses lists published keys, their selection, and selected keys not published", async () => {
	const host = await start({
		config: { layout: PINNED },
		statuses: { "aa-first": "A", "z-unlisted": "U", "bad\x1b[2Jkey": "x" },
	});
	try {
		await host.command("statuses");
		const report = host.state.notifications.at(-1).message;
		assert.equal(report, [
			"Published statuses:",
			'  "aa-first" — status item in bottomRight',
			'  "badkey" — not selected',
			'  "z-unlisted" — not selected',
			"Selected but not published:",
			'  "example-cost" — status item in topRight',
			'  "zz-last" — status item in bottomRight',
		].join("\n"));
	} finally {
		await host.shutdown();
	}
});
