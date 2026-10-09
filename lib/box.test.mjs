import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { measuredDirectly, rowWidth } from "./box.ts";

test("every character rowWidth counts itself is one column to pi-tui", () => {
	for (let code = 0; code <= 0xffff; code++) {
		if (!measuredDirectly(code)) continue;
		const char = String.fromCharCode(code);
		assert.equal(visibleWidth(char), 1, `U+${code.toString(16).padStart(4, "0")} ${char}`);
	}
});

test("rowWidth agrees with pi-tui's visibleWidth on every kind of row", () => {
	const rows = [
		"",
		"plain ascii",
		"\x1b[38;2;1;2;3mcolored\x1b[39m and \x1b[48;5;12mback\x1b[49m\x1b[0m",
		"│ ▌ 12 │ code · more … ⋯ ╭──╮",
		"\x1b[1m╰──\x1b[22m rule",
		"wide 日本語 text",
		"emoji 🎉 and flags 🇯🇵",
		"tab\there",
		"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
		"\uf0ad nerd font icon",
		"combining e\u0301",
	];
	for (const row of rows) assert.equal(rowWidth(row), visibleWidth(row), JSON.stringify(row));
});
