/**
 * Shared thinking-level colour scheme.
 *
 * The single source of truth for how a thinking level is coloured, so every
 * extension that renders the level draws the same thing: pi-context-footer's
 * `thinking:level` label and pi-model-picker's level rows import this module
 * instead of each keeping a private mapping.
 *
 * Two tiers, mirroring the escalation they encode:
 *
 *   - `off`/`minimal`/`low`/`medium` — pi's own theme palette via the
 *     `thinking*` theme colours (the same colours pi tints the editor border
 *     with; see Theme.getThinkingBorderColor).
 *   - `high`/`xhigh`/`max` — the pi-powerline-footer rainbow, with per-tier
 *     emphasis: `high` the plain gradient, `xhigh` bold over fg-derived
 *     backgrounds, `max` bold with a travelling holographic sheen.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * The `thinking*` entries of pi's `ThemeColor`, derived rather than retyped so
 * a rename upstream surfaces in a typecheck here instead of at runtime.
 */
export type ThinkingColor = Extract<
	ThemeColor,
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
>;

/**
 * The minimum a theme must provide to paint thinking levels. Both pi's own
 * `Theme` and a structural subset with a wider colour union (like the model
 * picker's `PickerTheme`) satisfy this.
 */
export interface ThinkingPalette {
	fg(color: ThinkingColor, text: string): string;
}

/**
 * Level → pi theme colour. The solid tier of the scheme, and the base colour
 * for level-tinted instruments that are not the label itself (gauges, icons).
 */
export const THINKING_LEVEL_COLORS: Readonly<Record<ModelThinkingLevel, ThinkingColor>> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

// Matches pi-powerline-footer's high-thinking gradient exactly; the last
// entry repeats the first so a full 8-character cycle ends where it began.
const RAINBOW_COLORS = [
	"#b281d6", "#d787af", "#febc38", "#e4c00f",
	"#89d281", "#00afaf", "#178fb9", "#b281d6",
];

/** How strongly the travelling highlight brightens a character, by distance from its centre. */
const SHEEN_FALLOFF = [0.85, 0.5, 0.2] as const;
/**
 * How far `xhigh`'s per-character background is dimmed from its foreground: the
 * tint keeps 30% of the character's brightness, so it reads as hue-matched
 * depth behind the glyph rather than a second palette.
 */
const BACKGROUND_DIM = 0.7;
/**
 * One highlight step per 80ms, the cadence of pi's own working spinner. The
 * sheen advances with `Date.now()`, so it only moves when something repaints
 * the screen — and pi repaints on demand. A caller showing the gloss must
 * therefore keep a `requestRender` interval of its own running at this same
 * cadence (see pi-context-footer's ticker); without it the shimmer would only
 * move when something else happened to trigger a render.
 */
export const THINKING_SHEEN_STEP_MS = 80;

interface RainbowStyle {
	/** Emit bold alongside each character's own color. */
	bold?: boolean;
	/** Back each character with a dark tint derived from its own foreground color. */
	background?: boolean;
	/** Overlay the travelling holographic highlight used by `max`. */
	sheen?: boolean;
}

/** Per-level rainbow treatment; `high` is the look `pi-powerline-footer` ships. */
const RAINBOW_STYLES: Readonly<Record<string, RainbowStyle | undefined>> = {
	high: {},
	xhigh: { bold: true, background: true },
	max: { bold: true, sheen: true },
};

function hexToRgb(hex: string): [number, number, number] {
	const value = hex.slice(1);
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

/** Foreground SGR for `hex`, optionally bold with a derived background. Each colored character's whole style rides inside its own escape, so consecutive characters never inherit each other's color; the reset in `rainbow()` keeps the label from painting past its end. */
function hexToAnsi(hex: string, bold = false, background?: string): string {
	const [red, green, blue] = hexToRgb(hex);
	const back = background === undefined ? "" : `;48;2;${hexToRgb(background).join(";")}`;
	return `\x1b[${bold ? "1;" : ""}38;2;${red};${green};${blue}${back}m`;
}

/** Blend a palette color toward white — the highlight is a gloss over the rainbow, not a color of its own. */
function towardWhite(hex: string, amount: number): string {
	const mix = (channel: number) =>
		Math.round(channel + (255 - channel) * amount)
			.toString(16)
			.padStart(2, "0");
	const [red, green, blue] = hexToRgb(hex);
	return `#${mix(red)}${mix(green)}${mix(blue)}`;
}

/** Dim a palette color toward black — `xhigh`'s background is derived from the character's own foreground. */
function towardBlack(hex: string, amount: number): string {
	const dim = (channel: number) =>
		Math.round(channel * (1 - amount))
			.toString(16)
			.padStart(2, "0");
	const [red, green, blue] = hexToRgb(hex);
	return `#${dim(red)}${dim(green)}${dim(blue)}`;
}

function rainbow(text: string, style: RainbowStyle, animated: boolean): string {
	const bold = style.bold ?? false;
	const characters = [...text];
	const coloredTotal = characters.filter((c) => c !== " " && c !== ":").length;
	const sheen = style.sheen === true && coloredTotal > 0;
	let center = 0;
	if (sheen) {
		// The highlight laps the label: measured on colored characters only, it
		// slides off the right edge as it enters on the left, so the loop has no
		// seam. It advances only while `animated` — the same predicate a caller
		// uses to run its repaint ticker — so a gloss that is not being driven
		// stays pinned at the head of the label instead of jumping on unrelated
		// renders.
		center = animated
			? Math.floor(Date.now() / THINKING_SHEEN_STEP_MS) % coloredTotal
			: 0;
	}

	let result = "";
	let colorIndex = 0;
	let position = 0;
	for (const character of characters) {
		// Spaces and the colon are emitted bare, inheriting the previous
		// character's attributes — the look `high` has always had. With
		// `xhigh`'s backgrounds that means the colon shares its neighbor's
		// tint, so the block reads as one continuous label.
		if (character === " " || character === ":") {
			result += character;
			continue;
		}
		let color = RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!;
		if (sheen) {
			const offset = Math.abs(position - center);
			const amount = SHEEN_FALLOFF[Math.min(offset, coloredTotal - offset)] ?? 0;
			if (amount > 0) color = towardWhite(color, amount);
		}
		const back = style.background === true ? towardBlack(color, BACKGROUND_DIM) : undefined;
		result += `${hexToAnsi(color, bold, back)}${character}`;
		colorIndex++;
		position++;
	}
	return `${result}\x1b[0m`;
}

/**
 * Paint `text` in the colour scheme for `level` — the one function both
 * extensions use, so a given level always looks the same wherever it appears.
 *
 * `animated` governs only the `max` sheen's travelling highlight: it advances
 * per THINKING_SHEEN_STEP_MS while true and stays pinned at the head of the
 * label while false (a caller that repaints only on events, like the model
 * picker, must pass false or the gloss jumps on every unrelated render).
 *
 * The rainbow tiers end in a full `\x1b[0m` reset, so anything styled after
 * the painted text on the same row must re-establish its own attributes — both
 * callers already do this.
 */
export function paintThinkingLevel(
	theme: ThinkingPalette,
	level: ModelThinkingLevel,
	text: string,
	animated = false,
): string {
	const style = RAINBOW_STYLES[level];
	if (style) return rainbow(text, style, animated);
	return theme.fg(THINKING_LEVEL_COLORS[level], text);
}
