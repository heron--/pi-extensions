import assert from "node:assert/strict";
import test from "node:test";
import { loadPalette, paint, parseInk } from "./colors.ts";
import { testTheme } from "./test-theme.mjs";

test("a color is a foreground token or a value a pi theme accepts", () => {
	assert.equal(parseInk("accent"), "accent");
	for (const value of ["#abc", "#aabbcc", "oklch(80% 0.12 300)", "okhsl(250 60% 55%)", 0, 255]) {
		assert.equal(typeof parseInk(value), "object", String(value));
	}
	for (const value of ["", "chartreuse", "userMessageBg", "emphasisText", 256, -1, 1.5, null, {}]) {
		assert.equal(parseInk(value), undefined, String(value));
	}
});

test("paint follows the theme for a token and its color mode for a value", () => {
	const theme = testTheme();
	assert.equal(paint(theme, "accent", "x"), theme.fg("accent", "x"));
	assert.equal(paint(theme, parseInk("#ff0000"), "x"), "\x1b[38;5;196mx\x1b[39m");
});

test("a palette keeps each role's default unless a valid color overrides it", () => {
	const roles = { label: "accent", box: { frame: "success", fill: "dim" } };
	const load = loadPalette(roles, { label: "#abc", box: { frame: "nope", extra: "dim" }, other: 1 });
	assert.deepEqual(load.palette, { label: parseInk("#abc"), box: { frame: "success", fill: "dim" } });
	assert.deepEqual(load.overrides, { label: "#abc" });
	assert.deepEqual(load.problems, [
		'"colors.other" is not a color role',
		'"colors.box.extra" is not a color role',
		'"colors.box.frame" must be a theme color name, #rgb, #rrggbb, oklch(…), okhsl(…), or 0–255',
	]);
	assert.deepEqual(loadPalette(roles, "red").problems, ['"colors" must be an object']);
	assert.deepEqual(loadPalette(roles, undefined), { palette: roles, overrides: {}, problems: [] });
});
