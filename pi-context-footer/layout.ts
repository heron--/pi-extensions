/**
 * Fitting resolved items into the frame's rules and the plain rows.
 *
 * Items arrive already resolved: only available ones, each with its display
 * text. Fitting decides visibility — which of them survive the width — and
 * never selection: an item cut here is still in the layout and comes back
 * when there is room.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** An available item and its display text. `id` identifies it for visibility checks. */
export interface ShownItem {
	id: string;
	text: string;
}

export interface Fitted {
	/** Display texts in order; the last may have been cut with `…`. */
	texts: string[];
	/** Ids of the items that are at least partly on screen. */
	visible: string[];
}

/** ` ── ` between items in a frame rule (lib/box.ts frameRuleRow). */
export const FRAME_SEPARATOR_WIDTH = 4;
/** `  ──  ` between items in a plain row. */
export const PLAIN_SEPARATOR_WIDTH = 6;
/** frameRuleRow's `╭── ` and ` ──╮` around a run. */
const FRAME_RUN_OVERHEAD = 8;
/** The extra ` ── ` fill frameRuleRow keeps between an anchored region and the other. */
const FRAME_ANCHOR_GAP = 4;

/**
 * Keep items in order while they fit in `budget` columns. The first item that
 * does not fit is cut with `…` to the room left; the ones after it are not
 * shown.
 */
export function fitItems(items: readonly ShownItem[], budget: number, separatorWidth: number): Fitted {
	const fitted: Fitted = { texts: [], visible: [] };
	let used = 0;
	for (const item of items) {
		const gap = fitted.texts.length > 0 ? separatorWidth : 0;
		const width = visibleWidth(item.text);
		if (used + gap + width <= budget) {
			fitted.texts.push(item.text);
			fitted.visible.push(item.id);
			used += gap + width;
			continue;
		}
		const room = budget - used - gap;
		if (room >= 1) {
			fitted.texts.push(truncateToWidth(item.text, room, "…"));
			fitted.visible.push(item.id);
		}
		break;
	}
	return fitted;
}

/**
 * Fit one frame rule: the anchored region keeps its room and the body takes
 * what is left. The budgets match frameRuleRow's geometry, so the row it draws
 * from these texts never needs to cut them again.
 */
export function fitFramedRow(
	width: number,
	anchor: readonly ShownItem[],
	body: readonly ShownItem[],
): { anchor: Fitted; body: Fitted } {
	const runBudget = width - FRAME_RUN_OVERHEAD;
	if (anchor.length === 0) {
		return { anchor: { texts: [], visible: [] }, body: fitItems(body, runBudget, FRAME_SEPARATOR_WIDTH) };
	}
	const contentBudget = runBudget - FRAME_ANCHOR_GAP;
	const fittedAnchor = fitItems(anchor, contentBudget, FRAME_SEPARATOR_WIDTH);
	const anchorWidth = visibleWidth(fittedAnchor.texts.join(" ".repeat(FRAME_SEPARATOR_WIDTH)));
	return { anchor: fittedAnchor, body: fitItems(body, contentBudget - anchorWidth, FRAME_SEPARATOR_WIDTH) };
}

/** Fit one plain row, cut at its end. */
export function fitPlainRow(width: number, items: readonly ShownItem[]): Fitted {
	return fitItems(items, width, PLAIN_SEPARATOR_WIDTH);
}
