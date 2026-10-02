import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

export interface RowCapState {
	/** Whether the last shown line was cut short. */
	lineCut: boolean;
	/** Lines after the shown ones. */
	remaining: number;
}

export interface RowCappedPreviewOptions {
	/** Output lines with terminal sequences already stripped. */
	lines: string[];
	maxRows: number;
	paintLine: (line: string) => string;
	/** Painted text for the row after a cut preview. */
	moreNotice: (state: RowCapState) => string;
	/** Painted text that always follows the preview. */
	footer?: string;
}

/**
 * Clips a line to `units` UTF-16 code units without splitting a surrogate
 * pair. A clipped line still fills every remaining row, because each code unit
 * is at least one column wide.
 */
function clipLine(line: string, units: number): string {
	if (line.length <= units) return line;
	const end = /[\uD800-\uDBFF]/.test(line.charAt(units - 1)) ? units - 1 : units;
	return line.slice(0, end);
}

function wrapRows(text: string, width: number): string[] {
	return text ? new Text(text, 0, 0).render(width) : [""];
}

/**
 * A preview capped at `maxRows` terminal rows after wrapping, so one very long
 * line cannot fill the screen. Wrapping depends on the render width, so the
 * cap is applied in `render` rather than when the result is built.
 */
export function rowCappedPreview(options: RowCappedPreviewOptions): Component {
	let cached: { width: number; rows: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (cached?.width === width) return cached.rows;
			const columns = Math.max(1, width);
			const rows: string[] = [];
			let lineCut = false;
			let index = 0;
			while (index < options.lines.length && rows.length < options.maxRows) {
				const room = options.maxRows - rows.length;
				const raw = options.lines[index]!;
				const line = clipLine(raw, room * columns);
				const wrapped = wrapRows(options.paintLine(line), width);
				index += 1;
				if (wrapped.length >= room && (wrapped.length > room || line.length < raw.length)) {
					rows.push(...wrapped.slice(0, room));
					lineCut = true;
					break;
				}
				rows.push(...wrapped);
			}
			const remaining = options.lines.length - index;
			if (lineCut || remaining > 0) rows.push(...wrapRows(options.moreNotice({ lineCut, remaining }), width));
			if (options.footer) rows.push(...wrapRows(options.footer, width));
			cached = { width, rows };
			return rows;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
}
