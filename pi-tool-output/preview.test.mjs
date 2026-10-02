import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { rowCappedPreview } from "./preview.ts";

const notice = ({ lineCut, remaining }) => `…${lineCut ? "cut" : ""}+${remaining}`;
const preview = (lines, maxRows, footer) =>
	rowCappedPreview({ lines, maxRows, paintLine: (line) => line, moreNotice: notice, footer });

test("rowCappedPreview caps one long line at the row limit", () => {
	const rows = preview(["x".repeat(1_000_000)], 8).render(40);
	assert.equal(rows.length, 9);
	assert.ok(rows.slice(0, 8).every((row) => visibleWidth(row) <= 40));
	assert.equal(rows[8].trim(), "…cut+0");
});

test("rowCappedPreview counts lines after a cut line", () => {
	const rows = preview(["short", "y".repeat(500), "after", "later"], 4).render(20);
	assert.equal(rows.length, 5);
	assert.equal(rows[0].trim(), "short");
	assert.equal(rows[4].trim(), "…cut+2");
});

test("rowCappedPreview shows short output whole and keeps its footer", () => {
	const rows = preview(["one", "", "three"], 8, "footer").render(20);
	assert.deepEqual(rows.map((row) => row.trim()), ["one", "", "three", "footer"]);
});

test("rowCappedPreview reports lines past the cap without a cut", () => {
	const rows = preview(["a", "b", "c", "d"], 2).render(20);
	assert.deepEqual(rows.map((row) => row.trim()), ["a", "b", "…+2"]);
});

test("rowCappedPreview treats a line that exactly fills the rows as complete", () => {
	const rows = preview(["z".repeat(40)], 2).render(20);
	assert.deepEqual(rows.map((row) => row.trim()), ["z".repeat(20), "z".repeat(20)]);
});

test("rowCappedPreview rewraps for a new width", () => {
	const component = preview(["w".repeat(100)], 3);
	assert.equal(component.render(50).length, 2);
	assert.equal(component.render(20).length, 4);
});
