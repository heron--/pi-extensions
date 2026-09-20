import assert from "node:assert/strict";
import test from "node:test";
import { backgroundAnsi, paint, TOOL_OUTPUT_BG, TOOL_OUTPUT_COLORS } from "./colors.ts";

/** A theme that only defines the named colors, mirroring `Theme.fg`'s throw. */
function themeWith(defined) {
	return {
		fg(color, text) {
			if (!defined.includes(color)) throw new Error(`Unknown theme color: ${color}`);
			return `<${color}>${text}`;
		},
		getBgAnsi(bg) {
			if (!defined.includes(bg)) throw new Error(`Unknown theme background color: ${bg}`);
			return `<bg:${bg}>`;
		},
	};
}

test("paint resolves a single color name", () => {
	assert.equal(paint(themeWith(["dim"]), "dim", "text"), "<dim>text");
});

test("paint walks a preference chain until the theme defines a color", () => {
	const chain = ["emphasisText", "accent"];
	assert.equal(paint(themeWith(["emphasisText", "accent"]), chain, "v"), "<emphasisText>v");
	assert.equal(paint(themeWith(["accent"]), chain, "v"), "<accent>v");
});

test("paint returns unstyled text rather than throwing when nothing resolves", () => {
	assert.equal(paint(themeWith([]), "dim", "text"), "text");
	assert.equal(paint(themeWith([]), ["emphasisText", "accent"], "text"), "text");
});

test("every palette entry resolves against Pi's stock colors", () => {
	// Stock themes lack `emphasisText`, so each chain must still find a match.
	const stock = themeWith(["accent", "success", "error", "warning", "muted", "dim"]);
	for (const [region, colors] of Object.entries(TOOL_OUTPUT_COLORS)) {
		for (const [name, spec] of Object.entries(colors)) {
			const painted = paint(stock, spec, "x");
			assert.match(painted, /^<[a-zA-Z]+>x$/, `${region}.${name} did not resolve`);
		}
	}
});

test("palette entries only name standard colors after the first candidate", () => {
	const standard = new Set(["accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
		"muted", "dim", "text", "thinkingText", "toolTitle", "toolOutput"]);
	for (const colors of Object.values(TOOL_OUTPUT_COLORS)) {
		for (const [name, spec] of Object.entries(colors)) {
			const last = typeof spec === "string" ? spec : spec.at(-1);
			assert.ok(standard.has(last), `${name} chain must end in a stock color, got ${last}`);
		}
	}
});

test("backgroundAnsi falls back to no background", () => {
	assert.equal(backgroundAnsi(themeWith([TOOL_OUTPUT_BG])), `<bg:${TOOL_OUTPUT_BG}>`);
	assert.equal(backgroundAnsi(themeWith([])), "");
});
