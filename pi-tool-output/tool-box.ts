import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CORNER_BL, CORNER_BR, CORNER_TL, CORNER_TR, groundRow, labelRuleRow, railRow } from "../lib/box.ts";
import { backgroundAnsi, paint, TOOL_OUTPUT_COLORS } from "./colors.ts";

export const ICON_TOOL = "\uf0ad"; // nf-fa-wrench
const PAD_X = 1;
const FRAME_WIDTH = 2;
/** Inner width of a house box drawn at `width`: the rails and their padding are paid for here. */
export function boxContentWidth(width: number): number {
	return Math.max(1, width - FRAME_WIDTH - PAD_X * 2);
}

/**
 * The unframed component each house box wraps. The grouped layout draws one box
 * around several tool calls, so it renders a call's content without the frame
 * that tool's own renderer put around it.
 */
const boxInners = new WeakMap<Component, Component>();
export function boxInner(component: unknown): Component | undefined {
	return typeof component === "object" && component !== null ? boxInners.get(component as Component) : undefined;
}
const MIN_BOX_WIDTH = 12;
const STATE_KEY = "__piToolOutputHouseBox";

interface HouseBoxState {
	resultAttached: boolean;
}

interface RenderContextState {
	state?: Record<string, unknown>;
}

function houseBoxState(context: RenderContextState): HouseBoxState {
	const contextState = context.state ?? (context.state = {});
	const existing = contextState[STATE_KEY];
	if (typeof existing === "object" && existing !== null && "resultAttached" in existing) {
		return existing as HouseBoxState;
	}
	const created: HouseBoxState = { resultAttached: false };
	contextState[STATE_KEY] = created;
	return created;
}

export function boxRows(
	theme: Theme,
	width: number,
	label: string,
	body: string[],
	options: { includeTop: boolean; close: boolean },
): string[] {
	const w = Math.max(0, Math.floor(width));
	const paintLabel = (text: string) => theme.bold(paint(theme, TOOL_OUTPUT_COLORS.box.label, text));
	if (w < MIN_BOX_WIDTH) {
		const rows = options.includeTop ? [paintLabel(label), ...body] : body;
		return rows.map((line) => truncateToWidth(line, w, "…"));
	}

	// Every railed row paints the same two rails: paint each glyph run once per box.
	const painted = new Map<string, string>();
	const paintFrame = (text: string) => {
		let result = painted.get(text);
		if (result === undefined) painted.set(text, (result = paint(theme, TOOL_OUTPUT_COLORS.box.frame, text)));
		return result;
	};
	const ground = (row: string) => groundRow(row, backgroundAnsi(theme));
	const contentWidth = boxContentWidth(w);
	const rows: string[] = [];
	if (options.includeTop) {
		rows.push(
			ground(
				labelRuleRow({
					width: w,
					paint: paintFrame,
					cornerL: CORNER_TL,
					cornerR: CORNER_TR,
					label: paintLabel(label),
					side: "left",
					padLabel: true,
				}),
			),
		);
	}
	rows.push(...body.map((line) => ground(railRow({ line, paint: paintFrame, padX: PAD_X, padTo: contentWidth }))));
	if (options.close) {
		rows.push(ground(labelRuleRow({ width: w, paint: paintFrame, cornerL: CORNER_BL, cornerR: CORNER_BR })));
	}
	return rows;
}

function renderInner(component: Component, width: number): string[] {
	return component.render(boxContentWidth(width));
}

function cachedBoxComponent(
	inner: Component,
	theme: Theme,
	label: string,
	includeTop: boolean,
	close: () => boolean,
): Component {
	let cached: { width: number; close: boolean; body: string[]; rows: string[] } | undefined;
	const box: Component = {
		render(width: number): string[] {
			const shouldClose = close();
			const body = renderInner(inner, width);
			// Cached pi text components retain their row-array identity. A dynamic
			// component returning new rows still flows through and rebuilds the box.
			if (cached?.width === width && cached.close === shouldClose && cached.body === body) return cached.rows;

			const rows = boxRows(theme, width, label, body, {
				includeTop,
				close: shouldClose,
			});
			cached = { width, close: shouldClose, body, rows };
			return rows;
		},
		invalidate(): void {
			cached = undefined;
			inner.invalidate();
		},
	};
	boxInners.set(box, inner);
	return box;
}

export function toolCallBox(
	displayName: string,
	argsComponent: Component,
	theme: Theme,
	context: RenderContextState,
): Component {
	const state = houseBoxState(context);
	return cachedBoxComponent(argsComponent, theme, `${ICON_TOOL} ${displayName}`, true, () => !state.resultAttached);
}

export function toolResultBox(
	resultComponent: Component,
	theme: Theme,
	context: RenderContextState,
): Component {
	const state = houseBoxState(context);
	state.resultAttached = true;
	return cachedBoxComponent(resultComponent, theme, "", false, () => true);
}
