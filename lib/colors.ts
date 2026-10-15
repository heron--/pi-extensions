/**
 * Color handling shared by every extension: pi's theme tokens, the colors an
 * owner may configure, and painting either one.
 *
 * A theme file may only define pi's own tokens, so a color pi has no token for
 * is an extension role: a name in the extension's palette whose default is a
 * token and which the owner may override in the extension's `config.json`.
 */

import type { Theme, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, parseColor } from "@earendil-works/pi-tui";

// `satisfies` fails the typecheck when pi adds or removes a token.
const FOREGROUNDS = {
	accent: true, border: true, borderAccent: true, borderMuted: true, success: true, error: true, warning: true,
	muted: true, dim: true, text: true, thinkingText: true, scrollbarTrack: true, scrollbarThumb: true,
	searchMatchText: true, userMessageText: true, customMessageText: true, customMessageLabel: true,
	toolTitle: true, toolOutput: true, mdHeading: true, mdLink: true, mdLinkUrl: true, mdCode: true,
	mdCodeBlock: true, mdCodeBlockBorder: true, mdQuote: true, mdQuoteBorder: true, mdHr: true, mdListBullet: true,
	toolDiffAdded: true, toolDiffRemoved: true, toolDiffContext: true, syntaxComment: true, syntaxKeyword: true,
	syntaxFunction: true, syntaxVariable: true, syntaxString: true, syntaxNumber: true, syntaxType: true,
	syntaxOperator: true, syntaxPunctuation: true, thinkingOff: true, thinkingMinimal: true, thinkingLow: true,
	thinkingMedium: true, thinkingHigh: true, thinkingXhigh: true, thinkingMax: true, bashMode: true,
} satisfies Record<ThemeColor, true>;

const BACKGROUNDS = {
	selectedBg: true, searchMatchBg: true, userMessageBg: true, customMessageBg: true,
	toolPendingBg: true, toolSuccessBg: true, toolErrorBg: true,
} satisfies Record<ThemeBg, true>;

export const THEME_COLORS = Object.keys(FOREGROUNDS) as readonly ThemeColor[];
export const THEME_BACKGROUNDS = Object.keys(BACKGROUNDS) as readonly ThemeBg[];

/** A foreground: a theme token, which follows theme switches, or a fixed color. */
export type Ink = ThemeColor | Color;

export function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === "string" && Object.hasOwn(FOREGROUNDS, value);
}

/**
 * A configured color: a foreground token, or a value a pi theme accepts as a
 * color (`#rgb`, `#rrggbb`, `oklch(…)`, `okhsl(…)`, or a 0–255 index).
 */
export function parseInk(value: unknown): Ink | undefined {
	if (isThemeColor(value)) return value;
	if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255 ? parseColor(value) : undefined;
	if (typeof value !== "string") return undefined;
	try {
		return parseColor(value);
	} catch {
		return undefined;
	}
}

export const INK_FORMS = "a theme color name, #rgb, #rrggbb, oklch(…), okhsl(…), or 0–255";

export function paint(theme: Theme, ink: Ink, text: string): string {
	return typeof ink === "string" ? theme.fg(ink, text) : theme.style(text, { fg: ink });
}

/** An extension's roles, each defaulting to a theme token. */
export interface Roles {
	readonly [role: string]: ThemeColor | Roles;
}

/** `Roles` with every default replaced by the color in effect. */
export type Palette<R extends Roles> = { readonly [K in keyof R]: R[K] extends Roles ? Palette<R[K]> : Ink };

export interface PaletteLoad<R extends Roles> {
	palette: Palette<R>;
	/** The valid part of the configured value, in its configured form. */
	overrides: Record<string, unknown>;
	problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an extension's `colors` config against its roles. A role left out,
 * unknown, or invalid keeps its default; every invalid entry is a problem.
 */
export function loadPalette<R extends Roles>(roles: R, configured: unknown, path = "colors"): PaletteLoad<R> {
	const palette: Record<string, unknown> = {};
	const overrides: Record<string, unknown> = {};
	const problems: string[] = [];
	if (configured !== undefined && !isRecord(configured)) problems.push(`"${path}" must be an object`);
	const given = isRecord(configured) ? configured : {};
	for (const key of Object.keys(given)) {
		if (!Object.hasOwn(roles, key)) problems.push(`"${path}.${key}" is not a color role`);
	}
	for (const [key, fallback] of Object.entries(roles)) {
		const value = given[key];
		if (typeof fallback !== "string") {
			const nested = loadPalette(fallback, value, `${path}.${key}`);
			palette[key] = nested.palette;
			if (Object.keys(nested.overrides).length > 0) overrides[key] = nested.overrides;
			problems.push(...nested.problems);
			continue;
		}
		const ink = value === undefined ? undefined : parseInk(value);
		if (value !== undefined && ink === undefined) problems.push(`"${path}.${key}" must be ${INK_FORMS}`);
		palette[key] = ink ?? fallback;
		if (ink !== undefined) overrides[key] = value;
	}
	return { palette: palette as Palette<R>, overrides, problems };
}
