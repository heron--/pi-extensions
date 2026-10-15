import assert from "node:assert/strict";
import test from "node:test";
import { paintThinkingLevel } from "./thinking-colors.ts";
import { testTheme } from "./test-theme.mjs";

test("the rainbow tiers render in the theme's color mode", () => {
	assert.match(paintThinkingLevel(testTheme("truecolor"), "high", "a"), /^\x1b\[38;2;178;129;214ma\x1b\[0m$/);
	assert.match(paintThinkingLevel(testTheme("256color"), "xhigh", "a"), /^\x1b\[1m\x1b\[38;5;\d+m\x1b\[48;5;\d+ma\x1b\[0m$/);
});

test("the solid tier uses the level's theme token", () => {
	const theme = testTheme();
	assert.equal(paintThinkingLevel(theme, "low", "a"), theme.fg("thinkingLow", "a"));
});
