import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plain } from "./harness.mjs";
import { fitFramedRow, fitItems, fitPlainRow } from "./layout.ts";

const items = (...texts) => texts.map((text, index) => ({ id: `i${index}`, text }));

test("items that fit are kept in order", () => {
	assert.deepEqual(fitItems(items("aaa", "bb", "c"), 20, 4), { texts: ["aaa", "bb", "c"], visible: ["i0", "i1", "i2"] });
});

test("the first item that does not fit is cut and the rest are hidden", () => {
	const fitted = fitItems(items("aaa", "bbbbbb", "c"), 11, 4);
	assert.deepEqual(fitted.visible, ["i0", "i1"]);
	assert.equal(plain(fitted.texts[1]), "bbb…");
	assert.equal(visibleWidth(fitted.texts.join("    ")), 11);
});

test("an item with no room left after its separator is hidden, not cut", () => {
	assert.deepEqual(fitItems(items("aaa", "bbb"), 7, 4).visible, ["i0"]);
});

test("styled and wide text is measured in visible columns", () => {
	const fitted = fitItems(items("\x1b[31m日本語\x1b[39m", "x"), 6, 4);
	assert.deepEqual(fitted.visible, ["i0"]);
	assert.ok(visibleWidth(fitted.texts[0]) <= 6);
});

test("framed rows protect the anchored region", () => {
	const anchor = items("anchored");
	const body = [{ id: "body", text: "a fairly long body item" }];
	const wide = fitFramedRow(60, anchor, body);
	assert.deepEqual([...wide.anchor.visible, ...wide.body.visible], ["i0", "body"]);

	// 30 columns: 18 for content, the anchor keeps its 8 and the body gets 10.
	const narrow = fitFramedRow(30, anchor, body);
	assert.deepEqual(narrow.anchor.texts, ["anchored"]);
	assert.equal(visibleWidth(narrow.body.texts[0]), 10);

	// Too narrow even for the anchor: it is cut and the body shows nothing.
	const tiny = fitFramedRow(16, anchor, body);
	assert.equal(visibleWidth(tiny.anchor.texts[0]), 4);
	assert.deepEqual(tiny.body.texts, []);
});

test("without an anchor the body has the whole run", () => {
	assert.equal(visibleWidth(fitFramedRow(30, [], [{ id: "b", text: "x".repeat(40) }]).body.texts[0]), 22);
});

test("plain rows are cut at their end", () => {
	assert.deepEqual(fitPlainRow(9, items("abc", "defgh")).texts.map(plain), ["abc"]);
	assert.deepEqual(fitPlainRow(12, items("abc", "defgh")).texts.map(plain), ["abc", "de…"]);
});
