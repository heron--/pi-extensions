import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { argumentSpans, CALL_LIMITS, compactArguments, expandedArguments, type ArgumentSpanKind } from "./arguments.ts";
import { paint, TOOL_OUTPUT_COLORS, type ColorSpec } from "./colors.ts";
import { summarizeToolCall } from "./summaries.ts";

/**
 * Spans within a value that carry their own color. A magnitude, its unit, the
 * separator inside a descriptor, and generated stand-in labels are all tinted
 * apart from the value tone, so `288 B · 1 line` reads as a measurement rather
 * than as two unrelated fields.
 */
const SPAN_COLORS: Readonly<Record<Exclude<ArgumentSpanKind, "text">, ColorSpec>> = {
	measure: TOOL_OUTPUT_COLORS.call.valueMeasure,
	unit: TOOL_OUTPUT_COLORS.call.valueUnit,
	separator: TOOL_OUTPUT_COLORS.call.valueSeparator,
	placeholder: TOOL_OUTPUT_COLORS.call.valuePlaceholder,
};

/**
 * Call arguments deliberately do not share the dim result tone: accent labels and
 * emphasized values make input metadata scannable before output begins. The parser is
 * display-only and only recognizes our own `key: value` field boundaries.
 */
interface KeyValueColors {
	plain: ColorSpec;
	key: ColorSpec;
	value: ColorSpec;
}

/** Paint a value, tinting recognized measure/unit/placeholder spans within it. */
function paintValue(theme: Theme, value: ColorSpec, text: string): string {
	const spans = argumentSpans(text);
	if (spans.length === 1 && spans[0]!.kind === "text") return paint(theme, value, text);
	return spans
		.map((span) => paint(theme, span.kind === "text" ? value : SPAN_COLORS[span.kind], span.text))
		.join("");
}

/** Paint a bounded `key: value · key: value` display row without reparsing tool input. */
function paintKeyValueLine(line: string, theme: Theme, colors: KeyValueColors): string {
	const matches = [...line.matchAll(/(^| · )(?:(?:"([^"]+)")|([A-Za-z_$][\w$.-]*)):\s*/g)];
	const plain = (text: string) => paint(theme, colors.plain, text);
	// A row with no fields is still prose that can carry generated labels.
	if (matches.length === 0) return paintValue(theme, colors.plain, line);
	let cursor = 0;
	let painted = "";
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!;
		const prefix = match[1] ?? "";
		const key = match[2] ?? match[3] ?? "";
		const keyStart = match.index! + prefix.length;
		const valueStart = match.index! + match[0].length;
		const nextStart = matches[index + 1]?.index ?? line.length;
		painted += plain(line.slice(cursor, keyStart));
		painted += paint(theme, colors.key, key);
		painted += plain(line.slice(keyStart + key.length, valueStart));
		painted += paintValue(theme, colors.value, line.slice(valueStart, nextStart));
		cursor = nextStart;
	}
	return painted + plain(line.slice(cursor));
}

function paintArguments(text: string, theme: Theme): string {
	const { argumentPlain, argumentKey, argumentValue } = TOOL_OUTPUT_COLORS.call;
	return text
		.split("\n")
		.map((line) => paintKeyValueLine(line, theme, { plain: argumentPlain, key: argumentKey, value: argumentValue }))
		.join("\n");
}

function paintSummary(text: string, theme: Theme): string {
	const { summaryPlain, summaryKey, summaryValue } = TOOL_OUTPUT_COLORS.call;
	return paintKeyValueLine(text, theme, { plain: summaryPlain, key: summaryKey, value: summaryValue });
}

/** Limits apply to physical rows, after wrapping, including on very narrow terminals. */
export function callArgumentsComponent(name: string, args: unknown, expanded: boolean, theme: Theme): Component {
	const summary = summarizeToolCall(name, args);
	const preview = expanded ? expandedArguments(args) : compactArguments(args, summary?.fields);
	let cached: { width: number; rows: string[] } | undefined;
	return {
		render(width) {
			if (cached?.width === width) return cached.rows;
			const w = Math.max(1, Math.floor(width));
			const rows: string[] = [];
			if (summary) rows.push(theme.bold(paintSummary(truncateToWidth(summary.text, w, "…"), theme)));
			const limit = expanded ? CALL_LIMITS.expandedRows : CALL_LIMITS.collapsedRows;
			const wrapped = preview.text ? wrapTextWithAnsi(paintArguments(preview.text.replace(/\t/g, "    "), theme), w) : [];
			rows.push(...wrapped.slice(0, limit).map((row) => truncateToWidth(row, w, "…")));
			const hidden = preview.hidden || wrapped.length > limit;
			if (expanded && hidden) {
				rows.push(paint(theme, TOOL_OUTPUT_COLORS.call.capNotice, truncateToWidth(`… arguments capped (${CALL_LIMITS.expandedRows} rows / ${CALL_LIMITS.expandedChars.toLocaleString("en-US")} chars / bounded depth)`, w, "…")));
			} else if (!expanded && (hidden || summary?.hidden || (summary && visibleWidth(summary.text) > w))) {
				rows.push(paint(theme, TOOL_OUTPUT_COLORS.call.expandHint, truncateToWidth(`… arguments · ${keyHint("app.tools.expand", "to expand")}`, w, "…")));
			}
			cached = { width, rows };
			return rows;
		},
		invalidate() { cached = undefined; },
	};
}
