/**
 * The thinking-level color scheme, so every extension that shows a level
 * draws it the same way. `off` through `medium` use pi's `thinking*` tokens;
 * `high`, `xhigh`, and `max` use the pi-powerline-footer rainbow, with `xhigh`
 * bold over tinted backgrounds and `max` bold with a travelling sheen.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, foregroundAnsi, mixColors, parseColor, rgbColor } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Each level's theme token: the solid tier, and the tint of level instruments such as gauges. */
export const THINKING_LEVEL_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const satisfies Record<ModelThinkingLevel, ThemeColor>;

// pi-powerline-footer's gradient; the last entry repeats the first so an
// 8-character cycle ends where it began.
const RAINBOW_COLORS = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9", "#b281d6"].map(parseColor);
const WHITE = rgbColor(255, 255, 255);
const BLACK = rgbColor(0, 0, 0);

/** How far the sheen lightens a character, by distance from its center. */
const SHEEN_FALLOFF = [0.85, 0.5, 0.2] as const;
/** How far `xhigh`'s background darkens each character's own color. */
const BACKGROUND_DIM = 0.7;
/**
 * The sheen's step, pi's spinner cadence. It moves only when something
 * repaints, so a caller showing it runs a repaint ticker at this interval.
 */
export const THINKING_SHEEN_STEP_MS = 80;
/** The pause on the plain rainbow between passes of the sheen. */
export const THINKING_SHEEN_HOLD_MS = 2000;

interface RainbowStyle {
	bold?: boolean;
	/** Back each character with a darkened copy of its color. */
	background?: boolean;
	sheen?: boolean;
}

const RAINBOW_STYLES: Readonly<Record<string, RainbowStyle | undefined>> = {
	high: {},
	xhigh: { bold: true, background: true },
	max: { bold: true, sheen: true },
};

/**
 * The opening sequence for one rainbow character. Each character carries its
 * whole style, so neighbors never inherit each other's color.
 */
function rainbowAnsi(theme: Theme, color: Color, bold: boolean, background?: Color): string {
	const mode = theme.getColorMode();
	return `${bold ? "\x1b[1m" : ""}${foregroundAnsi(color, mode)}${background ? backgroundAnsi(background, mode) : ""}`;
}

/** One piece of a level indicator, such as the model picker's gauge beside the level's name. */
export interface ThinkingSpan {
	text: string;
	/** False emits the span verbatim. */
	styled?: boolean;
}

function coloredLength(spans: ThinkingSpan[]): number {
	let total = 0;
	for (const span of spans) {
		if (span.styled === false) continue;
		for (const character of span.text) {
			if (character !== " " && character !== ":") total++;
		}
	}
	return total;
}

function rainbowSpans(theme: Theme, spans: ThinkingSpan[], style: RainbowStyle, animated: boolean): string {
	const bold = style.bold ?? false;
	const coloredTotal = coloredLength(spans);
	const sheen = style.sheen === true && coloredTotal > 0;
	let center = 0;
	let gloss = false;
	if (sheen) {
		if (animated) {
			// One pass across the colored characters, then a hold.
			const sweepMs = coloredTotal * THINKING_SHEEN_STEP_MS;
			const phase = Date.now() % (sweepMs + THINKING_SHEEN_HOLD_MS);
			gloss = phase < sweepMs;
			center = Math.floor(phase / THINKING_SHEEN_STEP_MS);
		} else {
			// Undriven, the gloss stays at the head instead of jumping on unrelated renders.
			gloss = true;
		}
	}

	let result = "";
	let colorIndex = 0;
	let position = 0;
	for (const span of spans) {
		// Reset before a verbatim span, or `xhigh`'s background bleeds onto it.
		if (span.styled === false) {
			if (result !== "") result += "\x1b[0m";
			result += span.text;
			continue;
		}
		for (const character of span.text) {
			// Spaces and colons inherit their neighbor's style, so `xhigh` reads
			// as one block; past the last colored character they reset instead.
			if (character === " " || character === ":") {
				if (coloredTotal > 0 && colorIndex >= coloredTotal) result += "\x1b[0m";
				result += character;
				continue;
			}
			let color = RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!;
			if (gloss) {
				const amount = SHEEN_FALLOFF[Math.abs(position - center)] ?? 0;
				if (amount > 0) color = mixColors(color, WHITE, amount, "srgb");
			}
			const back = style.background === true ? mixColors(color, BLACK, BACKGROUND_DIM, "srgb") : undefined;
			result += `${rainbowAnsi(theme, color, bold, back)}${character}`;
			colorIndex++;
			position++;
		}
	}
	return `${result}\x1b[0m`;
}

/**
 * Paint `text` in `level`'s scheme. Pass `animated` only while a repaint
 * ticker drives renders at THINKING_SHEEN_STEP_MS. The rainbow tiers end in a
 * full reset.
 */
export function paintThinkingLevel(
	theme: Theme,
	level: ModelThinkingLevel,
	text: string,
	animated = false,
): string {
	return paintThinkingSpans(theme, level, [{ text }], animated);
}

/** Paint an indicator made of spans; the styled spans form one run of the scheme. */
export function paintThinkingSpans(
	theme: Theme,
	level: ModelThinkingLevel,
	spans: ThinkingSpan[],
	animated = false,
): string {
	const style = RAINBOW_STYLES[level];
	if (style) return rainbowSpans(theme, spans, style, animated);
	const color = THINKING_LEVEL_COLORS[level];
	return spans
		.map((span) => (span.styled === false ? span.text : theme.fg(color, span.text)))
		.join("");
}

/**
 * Whether the `max` sheen may animate, one preference for every extension
 * that shows it. It lives in pi-context-footer's config, which
 * `/context-footer animate` writes.
 */
function animateConfigFile(): string {
	return join(getAgentDir(), "pi-context-footer", "config.json");
}

interface StoredAnimateConfig {
	animate?: boolean;
}

/** On unless the config turns it off. */
export function loadThinkingAnimatePreference(): boolean {
	try {
		const stored = JSON.parse(
			readFileSync(animateConfigFile(), "utf8"),
		) as StoredAnimateConfig;
		if (typeof stored.animate === "boolean") return stored.animate;
	} catch {
		// No config, or an unreadable one.
	}
	return true;
}

/** Persist the preference; returns false when the config file is not writable. */
export function saveThinkingAnimatePreference(value: boolean): boolean {
	return updateContextFooterConfig((config) => {
		config.animate = value;
	});
}

/** pi-context-footer's config file. */
export function contextFooterConfigFile(): string {
	return animateConfigFile();
}

/**
 * Rewrite pi-context-footer's config through `mutate`, keeping every other
 * key. A file that does not parse is left alone and reported as unwritable.
 */
export function updateContextFooterConfig(mutate: (config: Record<string, unknown>) => void): boolean {
	try {
		const file = animateConfigFile();
		let config: Record<string, unknown> = {};
		if (existsSync(file)) {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
			config = parsed as Record<string, unknown>;
		}
		mutate(config);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}
