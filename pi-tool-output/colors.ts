/**
 * Every color this extension paints, by the region of the house box it
 * paints. Each role defaults to a theme token; `colors` in the config
 * overrides any of them.
 */

import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors } from "@earendil-works/pi-tui";
import { loadPalette, type Palette, type PaletteLoad, type Roles } from "../lib/colors.ts";

export const TOOL_OUTPUT_COLOR_ROLES = {
	box: {
		frame: "success",
		/** The tool's icon and name in the top rule, drawn bold. */
		label: "success",
	},
	call: {
		summaryPlain: "success",
		summaryKey: "success",
		summaryValue: "accent",
		argumentPlain: "muted",
		argumentKey: "accent",
		argumentValue: "accent",
		/** Continuation lines of an expanded multi-line argument. */
		argumentBody: "accent",
		/** The `288` of a `288 B · 1 line` descriptor. */
		valueMeasure: "syntaxNumber",
		/** The `B` and `line` of a descriptor. */
		valueUnit: "syntaxType",
		/** The ` · ` inside a descriptor. */
		valueSeparator: "dim",
		/** Stand-ins such as `[circular]` and `<inline script>`. */
		valuePlaceholder: "muted",
		capNotice: "warning",
		expandHint: "dim",
	},
	/** Calls a codemode script made. */
	nestedCall: {
		name: "success",
		arguments: "accent",
		running: "warning",
		ok: "success",
		error: "error",
		cancelled: "muted",
		unknown: "muted",
		meta: "muted",
	},
	result: {
		output: "dim",
		error: "error",
		/** Truncation and display-cap notices. */
		notice: "warning",
		/** "… N more lines", "(no output)", "output hidden". */
		meta: "muted",
		/** The one-line summary of the `summary` output mode. */
		summary: "dim",
	},
	/** The grouped layout's per-call rows. */
	group: {
		name: "success",
		summaryPlain: "muted",
		summaryKey: "muted",
		/** "12 lines, 3.4 KB", "running…". */
		size: "muted",
		added: "toolDiffAdded",
		removed: "toolDiffRemoved",
		failed: "error",
		hintKey: "dim",
		hintText: "muted",
	},
	/** An expanded edit's or write's diff. Code in a known language takes its syntax colors. */
	diff: {
		added: "toolDiffAdded",
		removed: "toolDiffRemoved",
		context: "toolDiffContext",
		lineNumber: "dim",
		/** The gutter rule, the split separator, and the mark for skipped lines. */
		divider: "dim",
		/** The split layout's `old` and `new` headings. */
		header: "muted",
		/** `pending edit`, `new file`. */
		label: "muted",
		notice: "warning",
	},
} as const satisfies Roles;

export type ToolOutputColors = Palette<typeof TOOL_OUTPUT_COLOR_ROLES>;

export function loadToolOutputColors(configured: unknown): PaletteLoad<typeof TOOL_OUTPUT_COLOR_ROLES> {
	return loadPalette(TOOL_OUTPUT_COLOR_ROLES, configured);
}

/** The colors in effect, from the config loaded with the extension. Updated in place, so every importer sees a change. */
export const TOOL_OUTPUT_COLORS: ToolOutputColors = { ...loadToolOutputColors(undefined).palette };

export function useToolOutputColors(colors: ToolOutputColors): void {
	Object.assign(TOOL_OUTPUT_COLORS, colors);
}

/** The ground behind every row of the house box. */
export const TOOL_OUTPUT_BG: ThemeBg = "userMessageBg";

/** How far a changed diff row, and the words that changed in it, tint the ground toward the diff color. */
export const DIFF_TINTS = { row: 0.18, emphasis: 0.34 } as const;

const DIFF_TINT_SOURCES = { add: "toolDiffAdded", remove: "toolDiffRemoved" } as const;

export function diffTint(theme: Theme, kind: keyof typeof DIFF_TINT_SOURCES, strength: keyof typeof DIFF_TINTS): string {
	const colors = theme.colors;
	return backgroundAnsi(mixColors(colors[TOOL_OUTPUT_BG], colors[DIFF_TINT_SOURCES[kind]], DIFF_TINTS[strength], "srgb"), theme.getColorMode());
}
