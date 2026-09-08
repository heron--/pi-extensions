/**
 * Shared box/frame row generation — the house layout, in one place.
 *
 * Three extensions draw the same rounded box language:
 *
 *   - pi-user-message frames the user's message in the transcript,
 *   - pi-recap frames the recap entry,
 *   - pi-context-footer frames the prompt editor.
 *
 * They speak two dialects of the same rule, both defined here:
 *
 *   - **Prompt-frame rows** (`frameRuleRow`): status items are notches in a
 *     continuous rule, each item flanked by a fixed run of rule cells
 *     (`╭── item ── item ────╮`). The footer's runs carry segments on the
 *     rule itself, with an optional right-anchored trail.
 *   - **Transcript-box rows** (`labelRuleRow`): one label sits flush after a
 *     corner (`╭ label ────╮`, `╰──── label╯`). The user-message and recap
 *     boxes.
 *
 * `railRow` puts the rails on content rows for all three, and `isRuleRow`
 * recognizes a rule row when hunting for one.
 *
 * Everything here returns rows of EXACTLY the requested visible width — the
 * caller's width budget is respected or truncated, never overflowed, because
 * pi's TUI tears the whole screen down on an over-wide row.
 *
 * Backgrounds are applied per row by the caller (`bg` on `railRow` wraps the
 * whole row): a background applied around a row survives the `\x1b[39m`
 * foreground resets inside it, which is why the user-message and recap boxes
 * keep their ground while their content recolours.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** SGR sequences and OSC payloads — the widths the eye sees are what count. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/* -------------------------------------------------------------------------- */
/* Geometry constants                                                          */
/* -------------------------------------------------------------------------- */

export const RULE = "─";
export const RAIL = "│";
export const CORNER_TL = "╭";
export const CORNER_TR = "╮";
export const CORNER_BL = "╰";
export const CORNER_BR = "╯";
/** The footer's completion-list divider: the box keeps going below it. */
export const TEE_L = "├";
export const TEE_R = "┤";
/** A background applied per row survives an `\x1b[39m` but not an `\x1b[0m`. */
export const BG_RESET = "\x1b[49m";

/**
 * Apply `bgAnsi` across a whole row, re-asserted after every reset inside it
 * that clears a background — full `\x1b[0m` and bg-only `\x1b[49m` alike — which
 * a plain wrap cannot survive. The boxes' rows carry content that
 * legitimately emits both: the rainbow thinking badge closes with a full
 * reset (see lib/thinking-colors.ts), the editor's cursor styling uses one,
 * and pi's own message body ends each row with `\x1b[49m`. Only the background
 * is re-asserted: the reset's fg/attribute clearing was intended.
 */
export function groundRow(row: string, bgAnsi: string): string {
	const reassert = (reset: string) => `${reset}${bgAnsi}`;
	return `${bgAnsi}${row.replace(/\x1b\[0m|\x1b\[49m/g, reassert)}${BG_RESET}`;
}

/**
 * Recolor a background ANSI code (`\x1b[48;...m`) as the matching foreground
 * (`\x1b[38;...m`) — for painting ink in a color the theme only defines as a
 * background (e.g. a box's ground tone), since `Theme.fg` only accepts the
 * `ThemeColor` foreground palette and throws on a `ThemeBg` name.
 */
export function fgFromBg(bgAnsi: string): string {
	return bgAnsi.replace("48;", "38;");
}
/**
 * Closing an OSC 8 hyperlink after a truncation cut. Truncation can cut a link
 * before its terminator, leaving the rest of the row linked; closing again
 * costs no width.
 */
export const LINK_CLOSE = "\x1b]8;;\x07";

/** A paint callback — takes plain box characters, returns them styled. */
export type BoxPaint = (text: string) => string;
export type Align = "left" | "right";

/** `╭── ` before the first item, ` ──╮` after the last. */
const RULE_RUN = 2;
const LEAD_WIDTH = 1 + RULE_RUN + 1;
const TRAIL_WIDTH = 1 + RULE_RUN + 1;
/** Total cells the two corners take. */
const FRAME_WIDTH = 2;

/* -------------------------------------------------------------------------- */
/* Rule rows                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One horizontal run of the prompt-frame dialect: a continuous rule broken
 * only by the segments handed in, each flanked by a fixed rule run. The result
 * is always exactly `width` cells wide. `rightTrail` (the session name) is
 * anchored just before the right corner and implies a left-aligned body.
 */
export function frameRuleRow(
	width: number,
	paint: BoxPaint,
	leftCorner: string,
	rightCorner: string,
	align: Align,
	segments: string[],
	rightTrail: string[] = [],
): string {
	const present = segments.filter((segment) => segment.trim().length > 0);
	const trailPresent = rightTrail.filter((segment) => segment.trim().length > 0);
	if (present.length === 0 && trailPresent.length === 0) {
		return paint(leftCorner + RULE.repeat(width - FRAME_WIDTH) + rightCorner);
	}

	const budget = width - LEAD_WIDTH - TRAIL_WIDTH;
	let body = present.join(paint(` ${RULE.repeat(RULE_RUN)} `));
	if (visibleWidth(body) > budget) {
		body = truncateToWidth(body, budget, "…") + LINK_CLOSE;
	}

	if (trailPresent.length > 0) {
		let trailBody = trailPresent.join(paint(` ${RULE.repeat(RULE_RUN)} `));
		// Fixed overhead between the corner rules: corner + rule + space on each
		// side of the fill run (10 cells) once a trail is present.
		const contentBudget = width - LEAD_WIDTH - TRAIL_WIDTH - (RULE_RUN + 2);
		let bodyBudget = contentBudget - visibleWidth(trailBody);
		if (bodyBudget < 0) {
			// The trail alone is too wide; truncate it and give the body nothing.
			body = "";
			trailBody = truncateToWidth(trailBody, contentBudget, "…") + LINK_CLOSE;
		} else if (visibleWidth(body) > bodyBudget) {
			body = truncateToWidth(body, bodyBudget, "…") + LINK_CLOSE;
		}
		if (visibleWidth(body) === 0) {
			// No left-aligned body survives: render the trail as a plain right-aligned
			// run so the row is a single broken rule rather than a notch beside an
			// empty status slot.
			const fill = width - LEAD_WIDTH - visibleWidth(trailBody) - (TRAIL_WIDTH - RULE_RUN);
			return `${paint(leftCorner + RULE.repeat(fill))} ${trailBody}${paint(` ${RULE.repeat(RULE_RUN)}${rightCorner}`)}`;
		}
		const fill = width - LEAD_WIDTH - visibleWidth(body) - visibleWidth(trailBody) - (TRAIL_WIDTH + RULE_RUN);
		return `${paint(leftCorner + RULE.repeat(RULE_RUN))} ${body}${paint(` ${RULE.repeat(fill)}`)} ${trailBody}${paint(` ${RULE.repeat(RULE_RUN)}${rightCorner}`)}`;
	}

	// One rule run is fixed at the item end; the other absorbs the remainder.
	const fill = width - LEAD_WIDTH - visibleWidth(body) - (TRAIL_WIDTH - RULE_RUN);
	const leadRun = align === "left" ? RULE_RUN : fill;
	const trailRun = align === "left" ? fill : RULE_RUN;
	return `${paint(leftCorner + RULE.repeat(leadRun))} ${body}${paint(` ${RULE.repeat(trailRun)}${rightCorner}`)}`;
}

/**
 * One horizontal run of the transcript-box dialect: a single label sits flush
 * against one corner, or — with no label — the row is a plain rule. The
 * user-message box (`╭ ● User ────╮`) and pi-recap's frame
 * (`╭ ◉ Recap ────╮`, `╰──── generated by … ╯`).
 *
 * `label` arrives pre-styled. `padLabel` adds one unpainted space on each side
 * of it (the ` label ` form); without it the label sits flush against its
 * corner and the rule (the attribution form). `side` picks the corner the
 * label belongs to.
 */
export function labelRuleRow(opts: {
	width: number;
	paint: BoxPaint;
	cornerL: string;
	cornerR: string;
	label?: string;
	side?: "left" | "right";
	padLabel?: boolean;
}): string {
	const { width, paint, cornerL, cornerR, label, side = "left", padLabel = true } = opts;
	const inner = Math.max(0, width - FRAME_WIDTH);
	if (!label || visibleWidth(label) === 0) {
		return paint(cornerL + RULE.repeat(inner) + cornerR);
	}
	const shown = visibleWidth(label) > inner ? truncateToWidth(label, inner, "…") : label;
	const pad = padLabel ? " " : "";
	const budget = inner - (padLabel ? 2 : 0) - visibleWidth(shown);
	if (budget < 0) return paint(cornerL + RULE.repeat(inner) + cornerR);
	if (side === "left") {
		return `${paint(cornerL)}${pad}${shown}${pad}${paint(RULE.repeat(budget) + cornerR)}`;
	}
	return `${paint(cornerL + RULE.repeat(budget))}${pad}${shown}${pad}${paint(cornerR)}`;
}

/* -------------------------------------------------------------------------- */
/* Content rows                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Set `line` between the rails. The line is placed verbatim — pre-rendered
 * ANSI rows keep their styling, and the caller guarantees the width contract:
 *
 * - with `padTo`, the content is right-padded so the railed row is exactly
 *   `padTo + 2 * padX + 2` cells (the transcript boxes, whose content is
 *   caller-wrapped prose);
 * - without it, the line must already be exactly as wide as the space
 *   between the rails (the footer's editor rows and the user message's
 *   natively rendered body).
 *
 * `bg` wraps the whole row, so foreground resets inside the line leave the
 * background alone.
 */
export function railRow(opts: {
	line: string;
	paint: BoxPaint;
	/** Columns of air between a rail and the content. Default 1. */
	padX?: number;
	/** Right-pad the content to this visible width. */
	padTo?: number;
	/** Wrap the finished row in a background (the `\x1b[49m` trick). */
	bg?: (row: string) => string;
}): string {
	const { line, paint, padX = 1, padTo, bg } = opts;
	const pad = " ".repeat(padX);
	const content = padTo === undefined ? line : line + " ".repeat(Math.max(0, padTo - visibleWidth(line)));
	const row = `${paint(RAIL)}${pad}${content}${pad}${paint(RAIL)}`;
	return bg ? bg(row) : row;
}

/* -------------------------------------------------------------------------- */
/* Rule-row detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a pre-rendered row is one of pi's full-width rule rows (or a scroll
 * marker, which replaces a rule row). The footer hunts for these to know
 * where the editor's frame can sit.
 */
export function isRuleRow(line: string, width: number): boolean {
	const stripped = stripAnsi(line);
	if (visibleWidth(stripped) !== width) return false;
	if (!stripped.startsWith(RULE)) return false;
	return /^─+$/.test(stripped) || /[↑↓]/.test(stripped);
}
