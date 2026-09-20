import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { backgroundAnsi, paint, TOOL_OUTPUT_BG, TOOL_OUTPUT_COLORS } from "./colors.ts";

/**
 * Color names Pi's own stock theme defines, read from the live install rather
 * than retyped, so a palette entry naming a color Pi does not ship fails here.
 */
function stockThemeColors() {
	const paths = JSON.parse(readFileSync(path.resolve("tsconfig.paths.json"), "utf8")).compilerOptions.paths;
	const piRoot = path.dirname(path.dirname(paths["@earendil-works/pi-coding-agent"][0]));
	const theme = JSON.parse(readFileSync(path.join(piRoot, "dist/modes/interactive/theme/dark.json"), "utf8"));
	return Object.keys(theme.colors ?? {});
}

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

test("every palette entry resolves against Pi's stock theme", () => {
	// The stock theme lacks `emphasisText`, so each chain must still find a match.
	const stock = themeWith(stockThemeColors());
	for (const [region, colors] of Object.entries(TOOL_OUTPUT_COLORS)) {
		for (const [name, spec] of Object.entries(colors)) {
			assert.match(paint(stock, spec, "x"), /^<[a-zA-Z]+>x$/, `${region}.${name} did not resolve`);
		}
	}
});

test("every palette chain ends in a color Pi's stock theme defines", () => {
	const stock = new Set(stockThemeColors());
	assert.ok(stock.size > 10, "stock theme colors were not read");
	assert.ok(!stock.has("emphasisText"), "stock theme unexpectedly defines emphasisText");
	for (const [region, colors] of Object.entries(TOOL_OUTPUT_COLORS)) {
		for (const [name, spec] of Object.entries(colors)) {
			const last = typeof spec === "string" ? spec : spec.at(-1);
			assert.ok(stock.has(last), `${region}.${name} must end in a stock color, got ${last}`);
		}
	}
});

test("backgroundAnsi falls back to no background", () => {
	assert.equal(backgroundAnsi(themeWith([TOOL_OUTPUT_BG])), `<bg:${TOOL_OUTPUT_BG}>`);
	assert.equal(backgroundAnsi(themeWith([])), "");
});
