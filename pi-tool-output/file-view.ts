/**
 * The expanded body of an edit or write: the state of the change, its diff,
 * or why there is none, for the call at whatever point it has reached.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { paint, TOOL_OUTPUT_COLORS } from "./colors.ts";
import { diffComponent, type DiffViewOptions } from "./diff.ts";
import {
	editResultChange,
	pendingEditChange,
	pendingWriteChange,
	writeResultChange,
	type FileChange,
} from "./file-changes.ts";
import { extractTextOutput } from "./rendering.ts";

/** The parts of a tool call the file view reads. */
export interface FileCall {
	toolName: string;
	args: unknown;
	result?: { content?: unknown; details?: unknown; isError?: boolean };
	isPartial: boolean;
	/** Whether the arguments have finished streaming; a preview waits for them. */
	argsComplete: boolean;
	cwd: string;
}

export function isFileTool(name: string): name is "edit" | "write" {
	return name === "edit" || name === "write";
}

/**
 * What the call changes: previewed while it is pending, read from its result
 * once it has run. Undefined when its result does not say, such as a write
 * drawn by pi's own tool, which records no previous contents.
 */
export function fileChangeOf(call: FileCall): FileChange | undefined {
	const pending = !call.result || call.isPartial;
	if (pending) {
		if (!call.argsComplete) return { label: `pending ${call.toolName}` };
		return call.toolName === "edit" ? pendingEditChange(call.args, call.cwd) : pendingWriteChange(call.args, call.cwd);
	}
	return call.toolName === "edit"
		? editResultChange(call.result?.details)
		: writeResultChange(call.args, call.result?.details);
}

function pathOf(args: unknown): string | undefined {
	const path = typeof args === "object" && args !== null ? (args as Record<string, unknown>).path : undefined;
	return typeof path === "string" ? path : undefined;
}

/**
 * The call's expanded body, or undefined when there is nothing better to show
 * than its own result. A failed call shows its error.
 */
export function fileCallComponent(call: FileCall, theme: Theme, options: DiffViewOptions): Component | undefined {
	const { diff: colors, result } = TOOL_OUTPUT_COLORS;
	if (call.result?.isError && !call.isPartial) {
		const text = extractTextOutput(call.result).trim() || `${call.toolName === "edit" ? "Edit" : "Write"} failed`;
		return new Text(paint(theme, result.error, text), 0, 0);
	}
	const change = fileChangeOf(call);
	if (!change) return undefined;
	const parts: Component[] = [];
	if (change.label) parts.push(new Text(paint(theme, colors.label, change.label), 0, 0));
	if (change.notice) parts.push(new Text(paint(theme, colors.notice, change.notice), 0, 0));
	if (change.diff) parts.push(diffComponent(change.diff, theme, options, pathOf(call.args)));
	return stack(parts);
}

/**
 * Components drawn one under another. Unlike pi-tui's `Container`, it hands
 * back the same row array while nothing changed, which is what lets the
 * grouped layout skip rebuilding an unchanged box on every frame.
 */
function stack(parts: readonly Component[]): Component {
	let cached: { width: number; blocks: string[][]; rows: string[] } | undefined;
	return {
		render(width: number): string[] {
			const blocks = parts.map((part) => part.render(width));
			if (cached?.width === width && blocks.every((block, index) => block === cached!.blocks[index])) return cached.rows;
			cached = { width, blocks, rows: blocks.flat() };
			return cached.rows;
		},
		invalidate(): void {
			cached = undefined;
			for (const part of parts) part.invalidate();
		},
	};
}
