import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	changedSpans,
	chooseLayout,
	diffStats,
	layoutCell,
	parseDiff,
	renderDiffRows,
	wrapBreaks,
} from "./diff.ts";

/** Pi's live theme object, as renderers receive it. */
async function liveTheme() {
	const paths = JSON.parse(readFileSync(path.resolve("tsconfig.paths.json"), "utf8")).compilerOptions.paths;
	const piRoot = path.dirname(path.dirname(paths["@earendil-works/pi-coding-agent"][0]));
	initTheme("dark", false);
	return (await import(pathToFileURL(path.join(piRoot, "dist/modes/interactive/theme/theme.js")).href)).theme;
}

const theme = await liveTheme();
const plain = (rows) => rows.map((row) => stripTerminalSequences(row));
const OPTIONS = { viewMode: "auto", indicator: "bars", splitMinWidth: 120, wordWrap: true, maxRows: 0 };

const BEFORE = "function greet(name) {\n\tconst greeting = 'hello';\n\treturn greeting + name;\n}\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nconst wide = '日本';\n";
const AFTER = "function greet(name, punctuation) {\n\tconst greeting = 'hello there';\n\treturn greeting + name;\n}\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nconst wide = '日本語のテキスト';\nconst added = 'a long line that keeps going and going past the edge of any narrow column it is drawn in';\n";
const SAMPLE = generateDiffString(BEFORE, AFTER).diff;

test("parseDiff reads both line numbers, and where lines were skipped", () => {
	const entries = parseDiff(" 1 a\n-2 b\n+2 B\n+3 B2\n 3 c\n   ...\n 9 z\n+10 \n");
	assert.deepEqual(entries, [
		{ kind: "context", oldLine: 1, newLine: 1, text: "a" },
		{ kind: "remove", oldLine: 2, text: "b" },
		{ kind: "add", newLine: 2, text: "B" },
		{ kind: "add", newLine: 3, text: "B2" },
		{ kind: "context", oldLine: 3, newLine: 4, text: "c" },
		{ kind: "skip" },
		{ kind: "context", oldLine: 9, newLine: 10, text: "z" },
		{ kind: "add", newLine: 10, text: "" },
	]);
	assert.deepEqual(diffStats(entries), { added: 3, removed: 1 });
	assert.deepEqual(parseDiff("not a diff line"), [{ kind: "context", text: "not a diff line" }]);
});

test("changedSpans picks out the words that changed, and only between related lines", () => {
	const { before, after } = changedSpans("const greeting = 'hello';", "const greeting = 'hello there';");
	assert.deepEqual(before, []);
	assert.deepEqual(after.map(({ start, end }) => "const greeting = 'hello there';".slice(start, end)), ["there"]);
	const both = changedSpans("call(alpha beta)", "call(gamma delta)");
	assert.deepEqual(both.after.map(({ start, end }) => "call(gamma delta)".slice(start, end)), ["gamma delta"], "whitespace between changes joins them");
	const renamed = changedSpans("return a + b;", "return a - b;");
	assert.deepEqual(renamed.before.map(({ start, end }) => "return a + b;".slice(start, end)), ["+"]);
	assert.deepEqual(changedSpans("abc", "xyz"), { before: [], after: [] }, "unrelated lines are tinted whole");
	assert.deepEqual(changedSpans("same", "same"), { before: [], after: [] });
	assert.deepEqual(changedSpans("x".repeat(800), "y".repeat(800)), { before: [], after: [] });
	const wide = changedSpans("x = '日本'", "x = '日本語'");
	assert.deepEqual(wide.after, [{ start: 5, end: 11 }], "spans count display columns");
});

test("wrapBreaks keeps words whole unless a row would be left nearly empty", () => {
	assert.deepEqual(wrapBreaks("alpha beta gamma", 11), [11]);
	assert.deepEqual(wrapBreaks("abcdefghijkl", 5), [5, 10], "no space: break where the row fills");
	assert.deepEqual(wrapBreaks("a bcdefghijkl", 9), [9], "a space leaving the row under a third full does not count");
	assert.deepEqual(wrapBreaks("short", 10), []);
});

test("layoutCell fills rows exactly, wrapping or cutting, and carries styles across rows", () => {
	const red = "\x1b[38;2;255;0;0m";
	const rows = layoutCell(`${red}abcdefgh\x1b[39m`, 3, { wrap: true });
	assert.deepEqual(plain(rows), ["abc", "def", "gh "]);
	assert.ok(rows[1].startsWith(red), "a wrapped row re-applies the color");
	assert.deepEqual(plain(layoutCell("abcdefgh", 4, { wrap: false })), ["abc…"]);
	assert.deepEqual(plain(layoutCell("日本語", 5, { wrap: true })), ["日本 ", "語   "], "a wide character never splits");
	assert.deepEqual(plain(layoutCell("日本語", 5, { wrap: false })), ["日本…"]);
	assert.deepEqual(plain(layoutCell("ab日本語", 5, { wrap: false })), ["ab日…"]);
	assert.deepEqual(plain(layoutCell("abc日本", 5, { wrap: false })), ["abc… "], "cutting a wide character still fills the row");
	assert.deepEqual(plain(layoutCell("", 3, { wrap: true })), ["   "]);
	assert.deepEqual(plain(layoutCell("alpha beta", 7, { wrap: true, breaks: wrapBreaks("alpha beta", 7) })), ["alpha  ", "beta   "]);
	const tinted = layoutCell("ab\x1b[0mcd", 6, { wrap: true, background: "<bg>", emphasis: "<em>", spans: [{ start: 1, end: 2 }] });
	assert.equal(tinted[0], "<bg>a<em>b\x1b[0m<bg>c\x1b[49m".replace("\x1b[49m", "") + "d  \x1b[0m", "background follows the text through a reset; emphasis covers its span");
});

test("chooseLayout follows the view mode and the width it has", () => {
	assert.equal(chooseLayout(OPTIONS, 7), "summary");
	assert.equal(chooseLayout(OPTIONS, 12), "compact");
	assert.equal(chooseLayout(OPTIONS, 119), "unified");
	assert.equal(chooseLayout(OPTIONS, 120), "split");
	assert.equal(chooseLayout({ ...OPTIONS, viewMode: "unified" }, 200), "unified");
	assert.equal(chooseLayout({ ...OPTIONS, viewMode: "split" }, 60), "split");
	assert.equal(chooseLayout({ ...OPTIONS, viewMode: "split" }, 50), "unified", "too narrow for two columns");
	assert.equal(chooseLayout(OPTIONS, 200, true), "unified", "a one-sided diff has nothing to compare");
	const created = plain(renderDiffRows(parseDiff("+1 a\n+2 b"), 160, theme, OPTIONS));
	assert.doesNotMatch(created[0], /old/, "a new file stays in one column");
});

test("every row is exactly the width it is drawn at, in every layout and marker style", () => {
	const entries = parseDiff(SAMPLE);
	for (const indicator of ["bars", "classic", "none"]) {
		for (const wordWrap of [true, false]) {
			for (const width of [3, 7, 10, 17, 18, 24, 40, 51, 80, 119, 120, 160]) {
				const rows = renderDiffRows(entries, width, theme, { ...OPTIONS, indicator, wordWrap }, "greet.js");
				assert.ok(rows.length > 0);
				for (const row of rows) {
					assert.equal(visibleWidth(row), width, `${indicator}/${wordWrap ? "wrap" : "cut"} at ${width}: ${JSON.stringify(stripTerminalSequences(row))}`);
				}
			}
		}
	}
});

test("the unified layout numbers each line where it lives and marks the change", () => {
	const rows = plain(renderDiffRows(parseDiff(" 1 a\n-2 b\n+2 B\n 3 c"), 40, theme, OPTIONS, "x.txt"));
	assert.deepEqual(rows.map((row) => row.trimEnd()), ["   1 │ a", "▌  2 │ b", "▌  2 │ B", "   3 │ c"]);
	const classic = plain(renderDiffRows(parseDiff("-2 b\n+2 B"), 40, theme, { ...OPTIONS, indicator: "classic" }));
	assert.deepEqual(classic.map((row) => row.trimEnd()), [" 2 │- b", " 2 │+ B"]);
	const none = plain(renderDiffRows(parseDiff("-2 b\n+2 B"), 40, theme, { ...OPTIONS, indicator: "none" }));
	assert.deepEqual(none.map((row) => row.trimEnd()), [" 2 │ b", " 2 │ B"]);
	const skipped = plain(renderDiffRows(parseDiff(" 1 a\n   ...\n 9 z"), 40, theme, OPTIONS));
	assert.equal(skipped[1].trim(), "⋯");
});

test("the split layout pairs each removed line with its replacement", () => {
	const rows = plain(renderDiffRows(parseDiff(" 1 a\n-2 b\n+2 B\n+3 C\n 3 c"), 80, theme, { ...OPTIONS, viewMode: "split" }));
	assert.match(rows[0], /^\s+old\s+│\s+new\s*$/);
	assert.match(rows[2], /▌\s+2 │ b\s+│ ▌\s+2 │ B/);
	assert.match(rows[3], /^\s+│\s+│ ▌\s+3 │ C/, "an addition with nothing removed opposite");
	assert.match(rows[4], /\s+3 │ c\s+│\s+4 │ c/, "context shows each side's own number");
});

test("compact and summary layouts drop the gutter, then everything but the counts", () => {
	const entries = parseDiff("-2 b\n+2 B\n+3 C");
	assert.deepEqual(plain(renderDiffRows(entries, 12, theme, OPTIONS)).map((row) => row.trimEnd()), ["▌ b", "▌ B", "▌ C"]);
	assert.deepEqual(plain(renderDiffRows(entries, 7, theme, OPTIONS)).map((row) => row.trimEnd()), ["+2 -1"]);
});

test("a long diff is capped with a notice", () => {
	const long = Array.from({ length: 50 }, (_, index) => `+${index + 1} line ${index}`).join("\n");
	const rows = plain(renderDiffRows(parseDiff(long), 40, theme, { ...OPTIONS, maxRows: 10 }));
	assert.equal(rows.length, 11);
	assert.match(rows[10], /display capped at 10 lines/);
});

test("file content cannot write terminal sequences of its own", () => {
	const rows = renderDiffRows(parseDiff("+1 evil \x1b]0;title\x07\x1b[2Jtext\r"), 40, theme, OPTIONS);
	assert.doesNotMatch(rows.join(""), /\x1b\]|\x1b\[2J|\r/);
	assert.match(plain(rows)[0], /evil text/);
});

test("changed rows are tinted, and changed words more strongly", () => {
	const rows = renderDiffRows(parseDiff("-1 return a + b;\n+1 return a - b;"), 40, theme, OPTIONS, "x.ts");
	const backgrounds = (row) => new Set(row.match(/\x1b\[48;[0-9;]+m/g));
	assert.ok(backgrounds(rows[0]).size >= 2, "a row tint and an emphasis tint on the removed line");
	assert.ok(backgrounds(rows[1]).size >= 2);
	assert.notDeepEqual(backgrounds(rows[0]), backgrounds(rows[1]), "removed and added tints differ");
	const context = renderDiffRows(parseDiff(" 1 same"), 40, theme, OPTIONS, "x.ts");
	assert.equal(backgrounds(context[0]).size, 0, "unchanged lines keep the box's ground");
});
