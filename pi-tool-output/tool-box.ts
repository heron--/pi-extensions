import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CORNER_BL, CORNER_BR, CORNER_TL, CORNER_TR, groundRow, labelRuleRow, railRow } from "../lib/box.ts";

const ICON_TOOL = "\uf0ad"; // nf-fa-wrench
const PAD_X = 1;
const FRAME_WIDTH = 2;
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

function boxRows(
	theme: Theme,
	width: number,
	label: string,
	body: string[],
	options: { includeTop: boolean; close: boolean },
): string[] {
	const w = Math.max(0, Math.floor(width));
	if (w < MIN_BOX_WIDTH) {
		const rows = options.includeTop ? [theme.bold(theme.fg("success", label)), ...body] : body;
		return rows.map((line) => truncateToWidth(line, w, "…"));
	}

	const paint = (text: string) => theme.fg("success", text);
	const ground = (row: string) => groundRow(row, theme.getBgAnsi("userMessageBg"));
	const contentWidth = Math.max(1, w - FRAME_WIDTH - PAD_X * 2);
	const rows: string[] = [];
	if (options.includeTop) {
		rows.push(
			ground(
				labelRuleRow({
					width: w,
					paint,
					cornerL: CORNER_TL,
					cornerR: CORNER_TR,
					label: theme.bold(theme.fg("success", label)),
					side: "left",
					padLabel: true,
				}),
			),
		);
	}
	rows.push(...body.map((line) => ground(railRow({ line, paint, padX: PAD_X, padTo: contentWidth }))));
	if (options.close) {
		rows.push(ground(labelRuleRow({ width: w, paint, cornerL: CORNER_BL, cornerR: CORNER_BR })));
	}
	return rows;
}

function renderInner(component: Component, width: number): string[] {
	const contentWidth = Math.max(1, width - FRAME_WIDTH - PAD_X * 2);
	return component.render(contentWidth);
}

function cachedBoxComponent(
	inner: Component,
	theme: Theme,
	label: string,
	includeTop: boolean,
	close: () => boolean,
): Component {
	let cached: { width: number; close: boolean; body: string[]; rows: string[] } | undefined;
	return {
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
