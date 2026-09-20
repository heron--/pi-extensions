/**
 * Every color this extension paints.
 *
 * `TOOL_OUTPUT_COLORS` is the single source of truth: no call site names a
 * color directly, so editing a value here changes every row that uses it.
 *
 * Values are *theme color names*, not hex codes — the active theme resolves
 * them, so the palette follows theme switches. See `PaletteColor` for the
 * allowed names.
 *
 * A color the stock themes do not define is expressed as a fallback chain in
 * preference order (see `ColorSpec`); `paint` tries each in turn.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Color names that only project-local themes define. `Theme.fg` **throws** on
 * an unknown name, and these are absent from Pi's stock themes, so they are
 * only ever safe inside a `ColorSpec` that ends in a standard `ThemeColor`.
 *
 * `emphasisText` is defined by this machine's `frontier-funds` theme.
 */
export type ProjectThemeColor = "emphasisText";

/** A theme color name: Pi's standard palette, or a project-local addition. */
export type PaletteColor = ThemeColor | ProjectThemeColor;

/**
 * One color, or a preference chain tried left to right.
 *
 * `["emphasisText", "accent"]` resolves to `emphasisText` where the theme
 * defines it and `accent` otherwise. A chain ends with a standard `ThemeColor`
 * so at least one candidate always matches.
 */
export type ColorSpec = PaletteColor | readonly [PaletteColor, ...PaletteColor[]];

/** Theme *background* names this extension uses. Pi exports `ThemeColor` but not `ThemeBg`. */
export type PaletteBg = "userMessageBg";

/**
 * The palette, grouped by the region of the house box each color paints.
 *
 * Entries that share a value are listed separately so one region can be
 * retuned without disturbing the others.
 */
export const TOOL_OUTPUT_COLORS = {
	/** The house box itself: border rule, corners, and the tool-name label. */
	box: {
		/** Border rails, corners, and rules. Matches the footer's git branch tone. */
		frame: "success",
		/** The `nf-fa-wrench` icon and tool display name in the top rule (drawn bold). */
		label: "success",
	},

	/**
	 * The call row: a bold semantic summary, then the bounded argument preview.
	 * These tones are brighter than `result`, keeping input metadata scannable
	 * above the dimmed output.
	 */
	call: {
		/** Summary prose, and the separators between its `key: value` fields. */
		summaryPlain: "success",
		/** Field keys inside a summary. */
		summaryKey: "success",
		/** Field values inside a summary. */
		summaryValue: ["emphasisText", "accent"],
		/** Argument-preview prose and the ` · ` field separators. */
		argumentPlain: "muted",
		/** Argument keys (`path:`, `pattern:`). */
		argumentKey: "accent",
		/** Argument values. */
		argumentValue: ["emphasisText", "accent"],
		/** The "arguments capped" notice shown when an expanded preview hits its limit. */
		capNotice: "warning",
		/** The collapsed "… arguments · Ctrl+O to expand" hint. */
		expandHint: "dim",
	},

	/** The result rows attached beneath a call. */
	result: {
		/** Ordinary tool output. */
		output: "dim",
		/** Output of a failed tool, and the fallback failure message. */
		error: "error",
		/** Truncation and display-cap notices that must stay visible. */
		notice: "warning",
		/** Counts and status lines: "… N more lines", "(no output)", "output hidden". */
		meta: "muted",
		/** The one-line collapsed summary shown in `summary` output mode. */
		summary: "dim",
	},
} as const;

/** Background tone filling the house box behind every row. */
export const TOOL_OUTPUT_BG: PaletteBg = "userMessageBg";

function candidates(spec: ColorSpec): readonly PaletteColor[] {
	return typeof spec === "string" ? [spec] : spec;
}

/**
 * Paint `text` with the first color in `spec` that the active theme defines.
 *
 * `Theme.fg` throws on an unknown color name, which is the mechanism a
 * preference chain relies on. If no candidate resolves, the text is returned
 * unstyled — a missing color must never take the TUI down.
 */
export function paint(theme: Theme, spec: ColorSpec, text: string): string {
	for (const color of candidates(spec)) {
		try {
			return theme.fg(color as ThemeColor, text);
		} catch {
			// Not defined by this theme; fall through to the next candidate.
		}
	}
	return text;
}

/**
 * The box's ground background as a raw ANSI sequence, or `""` when the theme
 * does not define it (`groundRow` then simply adds no background).
 */
export function backgroundAnsi(theme: Theme, bg: PaletteBg = TOOL_OUTPUT_BG): string {
	try {
		return theme.getBgAnsi(bg);
	} catch {
		return "";
	}
}
