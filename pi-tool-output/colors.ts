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
import { foregroundAnsi, parseColor } from "@earendil-works/pi-tui";

/**
 * Color names that only project-local themes define. `Theme.fg` **throws** on
 * an unknown name, and these are absent from Pi's stock themes, so they are
 * only ever safe inside a `ColorSpec` that ends in a standard `ThemeColor`.
 *
 * `emphasisText` is defined by this machine's `frontier-funds` theme.
 */
export type ProjectThemeColor = "emphasisText";

/**
 * A literal `#rrggbb`, for a tone no theme names. It is rendered in the
 * theme's color mode (truecolor, or the nearest 256-color index) and does not
 * follow theme switches, so prefer a theme name where one fits.
 */
export type HexColor = `#${string}`;

/** A theme color name: Pi's standard palette, a project-local addition, or a literal hex. */
export type PaletteColor = ThemeColor | ProjectThemeColor | HexColor;

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
		/**
		 * Continuation lines of a multi-line value — a script body, a prompt, or a
		 * pretty-printed tree — shown expanded. These stay in the call's tone so an
		 * expanded command is never mistaken for dimmed result output.
		 */
		argumentBody: ["emphasisText", "accent"],
		/** Magnitudes inside a generated descriptor: the `288` of `288 B · 1 line`. */
		valueMeasure: "syntaxNumber",
		/** Units and type words beside a magnitude: `B`, `KB`, `lines`, `array`. */
		valueUnit: "syntaxType",
		/** The ` · ` **inside** a descriptor, distinct from the field separator. */
		valueSeparator: "dim",
		/** Generated stand-in labels: `[circular]`, `<inline script>`. */
		valuePlaceholder: "muted",
		/** The "arguments capped" notice shown when an expanded preview hits its limit. */
		capNotice: "warning",
		/** The collapsed "… arguments · Ctrl+O to expand" hint. */
		expandHint: "dim",
	},

	/** Executed calls reported by codemode, distinct from the script's output. */
	nestedCall: {
		name: "success",
		arguments: ["emphasisText", "accent"],
		running: "warning",
		ok: "success",
		error: "error",
		cancelled: "muted",
		unknown: "muted",
		meta: "muted",
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

	/** The grouped layout's per-call rows. */
	group: {
		/** The tool's icon and display name at the head of its first row (drawn bold). */
		name: "success",
		/**
		 * The summary's prose and field keys beside the name — a command sketch,
		 * `pattern:` — a subdued green under the name's. Field values keep
		 * `call.summaryValue`.
		 */
		summaryPlain: "#57a174",
		summaryKey: "#57a174",
		/** The output size after the summary: "12 lines, 3.4 KB", "running…". */
		size: "muted",
		/** Name and size of a failed call. */
		failed: "error",
		/** Key names in the expand hint under the most recent call. */
		hintKey: "dim",
		/** The words around them. */
		hintText: "muted",
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
		if (color.startsWith("#")) {
			try {
				const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
				return `${foregroundAnsi(parseColor(color), mode)}${text}\x1b[39m`;
			} catch {
				continue;
			}
		}
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
