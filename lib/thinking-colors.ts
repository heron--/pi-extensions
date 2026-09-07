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
 *
 * Indicators that surround the level's name (pi-model-picker's intensity
 * gauge) compose through `paintThinkingSpans`, so their cells join the same
 * run instead of sitting beside it in a flat colour.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * the screen — and pi repaints on demand. Both callers therefore keep a
 * `requestRender` interval of their own running at this same cadence while
 * their gloss is on screen (the footer while its frame carries `max`, the
 * model picker while its level list is open and a `max` row is offered);
 * without one the shimmer would only move when something else happened to
 * trigger a render.
 */
export const THINKING_SHEEN_STEP_MS = 80;

/**
 * How long the label holds on the plain rainbow between passes of the gloss:
 * the shimmer enters at the head, travels one cell per THINKING_SHEEN_STEP_MS,
 * exits at the tail, and rests for this long before the next pass — a periodic
 * glint rather than a constant chase.
 */
export const THINKING_SHEEN_HOLD_MS = 2000;

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

/**
 * One piece of a composed level indicator. Styled spans join the level's
 * tier treatment as ONE run — the palette (and the `max` sheen) flow across
 * them — while `styled: false` spans pass through verbatim, for segments
 * the caller styles itself (a fixed gap, dim gauge cells).
 */
export interface ThinkingSpan {
	/** The span's text. */
	text: string;
	/** Paint in the level's tier treatment; false emits the span verbatim. */
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

function rainbowSpans(spans: ThinkingSpan[], style: RainbowStyle, animated: boolean): string {
	const bold = style.bold ?? false;
	const coloredTotal = coloredLength(spans);
	const sheen = style.sheen === true && coloredTotal > 0;
	let center = 0;
	let gloss = false;
	if (sheen) {
		if (animated) {
			// The gloss enters at the head, advances one cell per
			// THINKING_SHEEN_STEP_MS, exits at the tail, and then the label holds
			// on the plain rainbow for THINKING_SHEEN_HOLD_MS before the next
			// pass — a periodic glint, not a constant chase. Measured on colored
			// characters only, and only while `animated`: the same predicate a
			// caller uses to run its repaint ticker drives it.
			const sweepMs = coloredTotal * THINKING_SHEEN_STEP_MS;
			const phase = Date.now() % (sweepMs + THINKING_SHEEN_HOLD_MS);
			gloss = phase < sweepMs;
			center = Math.floor(phase / THINKING_SHEEN_STEP_MS);
		} else {
			// A gloss that is not being driven stays pinned at the head of the
			// label instead of jumping on unrelated renders.
			gloss = true;
		}
	}

	let result = "";
	let colorIndex = 0;
	let position = 0;
	for (const span of spans) {
		// Verbatim spans — caller-styled gaps and dim cells — sit inside the
		// indicator without joining the gradient. Their own escapes carry a
		// foreground only, so reset first: without that, the previous colored
		// character's attributes bleed onto them — `xhigh`'s background would
		// tint the gauge's empty cell and the air around the name.
		if (span.styled === false) {
			if (result !== "") result += "\x1b[0m";
			result += span.text;
			continue;
		}
		for (const character of span.text) {
			// Spaces and the colon are emitted bare, inheriting the previous
			// character's attributes — the look `high` has always had. With
			// `xhigh`'s backgrounds that means the colon shares its neighbor's
			// tint, so the block reads as one continuous label. A bare character
			// past the last colored one is outside the block, though: it resets
			// first, so `xhigh`'s background stops where the word ends instead of
			// tinting the padding after it.
			if (character === " " || character === ":") {
				if (coloredTotal > 0 && colorIndex >= coloredTotal) result += "\x1b[0m";
				result += character;
				continue;
			}
			let color = RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!;
			if (gloss) {
				// No lapping wrap: the gloss enters and exits with the sweep, so the
			// distance to its centre is all the falloff needs.
				const amount = SHEEN_FALLOFF[Math.abs(position - center)] ?? 0;
				if (amount > 0) color = towardWhite(color, amount);
			}
			const back = style.background === true ? towardBlack(color, BACKGROUND_DIM) : undefined;
			result += `${hexToAnsi(color, bold, back)}${character}`;
			colorIndex++;
			position++;
		}
	}
	return `${result}\x1b[0m`;
}

/**
 * Paint `text` in the colour scheme for `level` — the one function both
 * extensions use, so a given level always looks the same wherever it appears.
 *
 * `animated` governs only the `max` sheen's travelling highlight: it advances
 * per THINKING_SHEEN_STEP_MS while true and stays pinned at the head of the
 * label while false. Pass true only while a repaint ticker is driving the
 * caller's renders at that cadence; a caller that repaints only on events
 * must pass false, or the gloss jumps on every unrelated render.
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
	return paintThinkingSpans(theme, level, [{ text }], animated);
}

/**
 * Paint a level indicator composed of `ThinkingSpan`s — the form for callers
 * whose indicator is more than the level's name. Styled spans form one
 * continuous tier run: on the rainbow tiers the gradient (and the `max`
 * sheen) flows straight across them — pi-model-picker's gauge joins its
 * level's name this way — while `styled: false` spans pass through verbatim.
 * On the solid tier each styled span gets the level's theme colour.
 */
export function paintThinkingSpans(
	theme: ThinkingPalette,
	level: ModelThinkingLevel,
	spans: ThinkingSpan[],
	animated = false,
): string {
	const style = RAINBOW_STYLES[level];
	if (style) return rainbowSpans(spans, style, animated);
	const color = THINKING_LEVEL_COLORS[level];
	return spans
		.map((span) => (span.styled === false ? span.text : theme.fg(color, span.text)))
		.join("");
}

/**
 * Whether the `max` sheen may animate anywhere it is drawn — one machine-wide
 * preference for the whole scheme, so the gloss moves in step in every
 * extension that shows it. `/context-footer animate on|off` writes it; every
 * caller that shows the gloss reads it.
 *
 * The file lives under the `pi-context-footer` directory of pi's own
 * agent-config directory, so a customized agent dir (PI_CODING_AGENT_DIR) is
 * respected without re-implementing the resolution, and NOT under
 * `<agent dir>/extensions/pi-context-footer/`, because that path resolves
 * into the git checkout via this repo's install symlinks and the config
 * would land in the repo. The directory name is historic — the toggle predates
 * the shared module — but the path stays so existing configs keep working.
 */
function animateConfigFile(): string {
	return join(getAgentDir(), "pi-context-footer", "config.json");
}

interface StoredAnimateConfig {
	/** Whether the `max` shimmer may animate. Absent means on, the default. */
	animate?: boolean;
}

/** The current preference, defaulting to on when there is no config. */
export function loadThinkingAnimatePreference(): boolean {
	try {
		const stored = JSON.parse(
			readFileSync(animateConfigFile(), "utf8"),
		) as StoredAnimateConfig;
		if (typeof stored.animate === "boolean") return stored.animate;
	} catch {
		// No config, or an unreadable one. Defaults are not worth an error.
	}
	return true;
}

/** Persist the preference; returns false when the config file is not writable. */
export function saveThinkingAnimatePreference(value: boolean): boolean {
	try {
		const file = animateConfigFile();
		mkdirSync(dirname(file), { recursive: true });
		const body: StoredAnimateConfig = { animate: value };
		writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}
