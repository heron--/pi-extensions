import { keyHint, type AgentToolResult, type CodemodeToolDetails, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { CALL_LIMITS, cleanArgumentText, compactArguments, expandedArguments, shortArgument } from "./arguments.ts";
import { paint, TOOL_OUTPUT_COLORS } from "./colors.ts";
import { displayToolName, pluralize, shortenPath } from "./rendering.ts";
import { summarizeToolCall } from "./summaries.ts";

/** Bounds on presentation work, independent of the script's output budget. */
export const CODEMODE_LIMITS = {
	calls: 256,
	expandedRows: 120,
	argumentChars: CALL_LIMITS.expandedChars,
	errorChars: 2000,
} as const;

type NativeCall = CodemodeToolDetails["calls"][number];
type Call = Omit<NativeCall, "id" | "status"> & { status: NativeCall["status"] | "unknown" };
const STATUS_ICONS = { running: "…", ok: "✓", error: "✗", cancelled: "⊘", unknown: "?" } as const;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readCall(value: unknown): Call | undefined {
	const call = record(value);
	if (typeof call.name !== "string" || !call.name.trim()) return undefined;
	return {
		name: shortArgument(call.name),
		args: typeof call.args === "string" ? call.args : "",
		status: typeof call.status === "string" && Object.hasOwn(STATUS_ICONS, call.status)
			? call.status as Call["status"] : "unknown",
		durationMs: finiteNumber(call.durationMs),
		cost: finiteNumber(call.cost),
		error: typeof call.error === "string" ? call.error : undefined,
	};
}

/** Only complete recorded JSON is decoded. Never evaluate or infer arguments from source. */
function callArguments(call: Call, expanded: boolean): { text: string; hidden: boolean } {
	if (!call.args) return { text: "", hidden: false };
	if (call.name === "models.classify") {
		const limit = expanded ? CODEMODE_LIMITS.argumentChars : CALL_LIMITS.inlineChars;
		return { text: shortArgument(call.args, limit), hidden: call.args.length > limit };
	}
	try {
		if (call.args.length > CODEMODE_LIMITS.argumentChars) throw new Error("Argument preview too large");
		const args: unknown = JSON.parse(call.args);
		if (expanded) return expandedArguments(args);
		const summary = summarizeToolCall(call.name, args);
		const preview = compactArguments(args, summary?.fields);
		return {
			text: [summary?.text, preview.text].filter(Boolean).join(" · "),
			hidden: preview.hidden || summary?.hidden === true,
		};
	} catch {
		// Pi's native preview is capped at 200 characters and can end mid-JSON.
		return expanded
			? { text: cleanArgumentText(call.args.slice(0, CODEMODE_LIMITS.argumentChars)), hidden: call.args.length > CODEMODE_LIMITS.argumentChars }
			: { text: "arguments preview incomplete", hidden: true };
	}
}

function duration(ms: number | undefined): string {
	return ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function cost(usd: number): string {
	return `$${usd >= 0.01 ? usd.toFixed(2) : usd.toPrecision(2)}`;
}

/** Compress only Pi's exact metadata header; arbitrary script output is not parsed. */
export function codemodeOutput(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const first = result.content[0];
	const match = first?.type === "text" ? SCRIPT_HEADER.exec(first.text) : null;
	return match
		? { ...result, content: [{ type: "text", text: `Script ${match[1]} · ${match[2]}s` }, ...result.content.slice(1)] }
		: result;
}

export function codemodeFullOutputNotice(details: unknown): string | undefined {
	const path = record(details).fullOutputPath;
	return typeof path === "string" && path.trim()
		? `↳ full output: ${shortArgument(shortenPath(path), 1024)}` : undefined;
}

/** Live and replayed nested-call metadata. No nested output or tool execution is involved. */
export function codemodeCallsComponent(
	details: unknown,
	expanded: boolean,
	theme: Theme,
	collapsedCalls: number,
): Component {
	const raw = record(details).calls;
	const all: unknown[] = Array.isArray(raw) ? raw : [];
	const count = expanded ? CODEMODE_LIMITS.calls : Math.min(CODEMODE_LIMITS.calls, collapsedCalls);
	const start = Math.max(0, all.length - count);
	const calls = all.slice(start).map(readCall).filter((call): call is Call => call !== undefined);
	const previews = calls.map((call) => callArguments(call, expanded));
	let cached: { width: number; rows: string[] } | undefined;
	return {
		render(width) {
			if (cached?.width === width) return cached.rows;
			const w = Math.max(1, Math.floor(width));
			const rows: string[] = [];
			const palette = TOOL_OUTPUT_COLORS.nestedCall;
			let hidden = false;
			let capped = false;
			const add = (line: string) => {
				line = line.replace(/\t/g, "    ");
				const wrapped = expanded ? wrapTextWithAnsi(line, w) : [truncateToWidth(line, w, "…")];
				if (expanded) {
					const remaining = Math.max(0, CODEMODE_LIMITS.expandedRows - rows.length);
					rows.push(...wrapped.slice(0, remaining).map((row) => truncateToWidth(row, w, "…")));
					capped ||= wrapped.length > remaining;
				} else {
					rows.push(...wrapped);
					hidden ||= visibleWidth(line) > w;
				}
			};
			if (start > 0) {
				const notice = expanded ? `… ${start} earlier calls omitted (display capped)`
					: `… ${start} earlier ${pluralize(start, "call")} · ${keyHint("app.tools.expand", "to expand")}`;
				add(paint(theme, TOOL_OUTPUT_COLORS.result.meta, notice));
			}
			for (const [index, call] of calls.entries()) {
				if (expanded && rows.length >= CODEMODE_LIMITS.expandedRows) { capped = true; break; }
				const preview = previews[index]!;
				const label = call.name === "models.classify" ? "Classify" : displayToolName(call.name);
				const timing = [duration(call.durationMs), call.cost ? cost(call.cost) : ""].filter(Boolean).join(" · ");
				let header = `${paint(theme, palette[call.status], STATUS_ICONS[call.status])} ${paint(theme, palette.name, label)}`;
				if (!expanded && preview.text) header += ` · ${paint(theme, palette.arguments, preview.text)}`;
				if (timing) header += ` ${paint(theme, palette.meta, `· ${timing}`)}`;
				add(header);
				hidden ||= preview.hidden;
				if (expanded && preview.text) {
					for (const line of preview.text.replace(/\t/g, "    ").split("\n")) {
						add(paint(theme, palette.arguments, `  ${line}`));
						if (capped) break;
					}
				}
				if (call.error) {
					const limit = expanded ? CODEMODE_LIMITS.errorChars : CALL_LIMITS.inlineChars;
					const error = expanded ? cleanArgumentText(call.error.slice(0, limit)) : shortArgument(call.error);
					add(paint(theme, palette.error, `  ${error}`));
					hidden ||= call.error.length > limit || (!expanded && /[\r\n]/.test(call.error));
				}
			}
			const priced = calls.filter((call) => call.cost);
			// Never present a subtotal of a capped list as the script's total cost.
			if (start === 0 && priced.length > 1) {
				add(paint(theme, palette.meta, `Model calls: ${cost(priced.reduce((sum, call) => sum + call.cost!, 0))}`));
			}
			if (expanded && (capped || hidden)) {
				rows.push(paint(theme, TOOL_OUTPUT_COLORS.result.notice, truncateToWidth("… nested call details capped", w, "…")));
			} else if (!expanded && hidden) {
				rows.push(paint(theme, TOOL_OUTPUT_COLORS.call.expandHint, truncateToWidth(`… call details · ${keyHint("app.tools.expand", "to expand")}`, w, "…")));
			}
			cached = { width, rows };
			return rows;
		},
		invalidate() { cached = undefined; },
	};
}
