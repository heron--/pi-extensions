/**
 * The diff view for file edits and writes.
 *
 * It reads pi's display diff — `+12 text` (added, new line number),
 * `-12 text` (removed, old line number), ` 12 text` (context, old line
 * number), and ` … ...` where unchanged lines were skipped — and lays it out
 * for the width it is drawn at:
 *
 * - `split`: old and new side by side, each with its own line numbers.
 * - `unified`: one column, removed lines before the lines that replace them.
 * - `compact`: no line numbers, for very narrow widths.
 * - `summary`: just `+added -removed`, when not even that fits.
 *
 * Code is syntax-highlighted by its file's language. Changed rows are tinted,
 * and where a removed line pairs with the line replacing it, the words that
 * changed are tinted more strongly.
 *
 * Every row is exactly the width it is rendered at. The rows sit inside the
 * house box, and pi tears the TUI down on a row wider than the terminal.
 */

import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { diffTint, paint, TOOL_OUTPUT_COLORS, type ColorSpec } from "./colors.ts";
import type { DiffIndicatorMode, DiffViewMode, ToolOutputConfig } from "./config.ts";
import { sanitizeAnsiForToolOutput } from "./rendering.ts";

export interface DiffViewOptions {
	viewMode: DiffViewMode;
	indicator: DiffIndicatorMode;
	/** Columns the view needs before `auto` puts old and new side by side. */
	splitMinWidth: number;
	/** Wrap long lines; otherwise cut them with an ellipsis. */
	wordWrap: boolean;
	/** Rendered rows shown before the view is capped; 0 shows every row. */
	maxRows: number;
}

type LineKind = "add" | "remove" | "context";

export interface DiffLine {
	kind: LineKind;
	oldLine?: number;
	newLine?: number;
	text: string;
}

export type DiffEntry = DiffLine | { kind: "skip" };

/** The diff view's options, from the extension's configuration. */
export function diffViewOptions(config: ToolOutputConfig): DiffViewOptions {
	return {
		viewMode: config.diffViewMode,
		indicator: config.diffIndicatorMode,
		splitMinWidth: config.diffSplitMinWidth,
		wordWrap: config.diffWordWrap,
		maxRows: config.expandedPreviewMaxLines,
	};
}

/** Display columns of one character. Printable ASCII, nearly all of any code, skips the general measure. */
function charWidth(char: string): number {
	const code = char.charCodeAt(0);
	return char.length === 1 && code >= 0x20 && code < 0x7f ? 1 : visibleWidth(char);
}

/** Display columns of a string without escape sequences. */
function textWidth(text: string): number {
	return /^[\x20-\x7e]*$/.test(text) ? text.length : visibleWidth(text);
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const DIFF_LINE = /^([+\- ])(\s*\d*) (.*)$/;

/**
 * Parse pi's display diff. Context lines carry only their old line number;
 * their new one follows from the lines added and removed before them.
 */
export function parseDiff(diff: string): DiffEntry[] {
	const entries: DiffEntry[] = [];
	let shift = 0;
	for (const raw of diff.split("\n")) {
		const match = DIFF_LINE.exec(raw);
		if (!match) {
			if (raw.trim()) entries.push({ kind: "context", text: raw });
			continue;
		}
		const [, sign, digits, text] = match as unknown as [string, string, string, string];
		const number = digits.trim() ? Number(digits) : undefined;
		if (number === undefined) {
			if (sign === " " && text === "...") entries.push({ kind: "skip" });
			else entries.push({ kind: sign === "+" ? "add" : sign === "-" ? "remove" : "context", text });
			continue;
		}
		if (sign === "+") {
			entries.push({ kind: "add", newLine: number, text });
			shift++;
		} else if (sign === "-") {
			entries.push({ kind: "remove", oldLine: number, text });
			shift--;
		} else {
			entries.push({ kind: "context", oldLine: number, newLine: number + shift, text });
		}
	}
	return entries;
}

export function diffStats(entries: readonly DiffEntry[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const entry of entries) {
		if (entry.kind === "add") added++;
		else if (entry.kind === "remove") removed++;
	}
	return { added, removed };
}

/* -------------------------------------------------------------------------- */
/* Pairing and changed words                                                   */
/* -------------------------------------------------------------------------- */

/** One row of the side-by-side layout: a line on either side, or a skip. */
interface PairedRow {
	left?: DiffLine;
	right?: DiffLine;
	skip?: true;
}

/**
 * Pair each run of removed lines with the run of added lines beside it, in
 * order: the first removed line faces the first added one, and so on. A
 * context line faces itself.
 */
function pairRows(entries: readonly DiffEntry[]): PairedRow[] {
	const rows: PairedRow[] = [];
	let removed: DiffLine[] = [];
	let added: DiffLine[] = [];
	const flush = () => {
		for (let index = 0; index < Math.max(removed.length, added.length); index++) {
			rows.push({ left: removed[index], right: added[index] });
		}
		removed = [];
		added = [];
	};
	for (const entry of entries) {
		if (entry.kind === "remove") removed.push(entry);
		else if (entry.kind === "add") added.push(entry);
		else {
			flush();
			rows.push(entry.kind === "skip" ? { skip: true } : { left: entry, right: entry });
		}
	}
	flush();
	return rows;
}

/** A run of display columns, `[start, end)`. */
interface Span {
	start: number;
	end: number;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
/** Longer lines are tinted whole: word matching them costs more than it shows. */
const MAX_PAIRED_LENGTH = 700;
/** Below this share of matching characters the lines are unrelated, and picking out words is noise. */
const MIN_SIMILARITY = 0.3;

/**
 * The columns that differ between a removed line and the line replacing it,
 * from a longest common subsequence of their words. Empty when the lines are
 * too different for the words to say anything.
 */
export function changedSpans(before: string, after: string): { before: Span[]; after: Span[] } {
	const none = { before: [], after: [] };
	if (before === after || before.length > MAX_PAIRED_LENGTH || after.length > MAX_PAIRED_LENGTH) return none;
	const left = before.match(TOKEN) ?? [];
	const right = after.match(TOKEN) ?? [];
	let head = 0;
	while (head < left.length && head < right.length && left[head] === right[head]) head++;
	let tail = 0;
	while (
		tail < left.length - head &&
		tail < right.length - head &&
		left[left.length - 1 - tail] === right[right.length - 1 - tail]
	) {
		tail++;
	}
	const leftMiddle = left.slice(head, left.length - tail);
	const rightMiddle = right.slice(head, right.length - tail);
	// table[i][j]: common subsequence length of leftMiddle[i..] and rightMiddle[j..].
	const table = Array.from({ length: leftMiddle.length + 1 }, () => new Uint16Array(rightMiddle.length + 1));
	for (let i = leftMiddle.length - 1; i >= 0; i--) {
		for (let j = rightMiddle.length - 1; j >= 0; j--) {
			table[i]![j] =
				leftMiddle[i] === rightMiddle[j]
					? table[i + 1]![j + 1]! + 1
					: Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}
	const leftKept = new Array<boolean>(left.length).fill(true);
	const rightKept = new Array<boolean>(right.length).fill(true);
	for (let index = 0; index < leftMiddle.length; index++) leftKept[head + index] = false;
	for (let index = 0; index < rightMiddle.length; index++) rightKept[head + index] = false;
	for (let i = 0, j = 0; i < leftMiddle.length && j < rightMiddle.length; ) {
		if (leftMiddle[i] === rightMiddle[j]) {
			leftKept[head + i] = true;
			rightKept[head + j] = true;
			i++;
			j++;
		} else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
		else j++;
	}
	const keptLength = (tokens: string[], kept: boolean[]) =>
		tokens.reduce((sum, token, index) => sum + (kept[index] ? token.length : 0), 0);
	const similarity = Math.max(keptLength(left, leftKept), keptLength(right, rightKept)) / Math.max(before.length, after.length, 1);
	if (similarity < MIN_SIMILARITY) return none;
	return { before: spansOf(left, leftKept), after: spansOf(right, rightKept) };
}

/**
 * Column spans of the words not kept. Whitespace counts as changed only
 * between two changed words, so a run of changes reads as one span.
 */
function spansOf(tokens: string[], kept: boolean[]): Span[] {
	const spans: Span[] = [];
	let column = 0;
	for (const [index, token] of tokens.entries()) {
		const width = textWidth(token);
		const changed = /^\s+$/.test(token)
			? index > 0 && index < tokens.length - 1 && !kept[index - 1] && !kept[index + 1]
			: !kept[index];
		if (changed) {
			const last = spans.at(-1);
			if (last && last.end === column) last.end = column + width;
			else spans.push({ start: column, end: column + width });
		}
		column += width;
	}
	return spans;
}

/* -------------------------------------------------------------------------- */
/* Highlighting                                                                */
/* -------------------------------------------------------------------------- */

const TAB = "    ";

/** File content as it is safe to draw: no terminal sequences of its own, tabs as spaces. */
function displayText(text: string): string {
	return sanitizeAnsiForToolOutput(text).replace(/\t/g, TAB).replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
}

/** Highlighted lines, per theme and language, so laying a diff out again does not highlight it again. */
const highlightCache = new WeakMap<Theme, Map<string, string>>();

function codeColor(kind: LineKind): ColorSpec {
	const { added, removed, context } = TOOL_OUTPUT_COLORS.diff;
	return kind === "add" ? added : kind === "remove" ? removed : context;
}

/**
 * One line of code, painted: in syntax colors when the file's language is
 * known, otherwise in the line's diff color.
 */
function paintCode(theme: Theme, text: string, kind: LineKind, language: string | undefined): string {
	if (!language || !text.trim()) return paint(theme, codeColor(kind), text);
	let cache = highlightCache.get(theme);
	if (!cache) highlightCache.set(theme, (cache = new Map()));
	const key = `${language}\0${text}`;
	let highlighted = cache.get(key);
	if (highlighted === undefined) {
		try {
			highlighted = highlightCode(text, language)[0] ?? text;
		} catch {
			highlighted = paint(theme, codeColor(kind), text);
		}
		if (cache.size > 5000) cache.clear();
		cache.set(key, highlighted);
	}
	return highlighted;
}

export function languageOf(path: string | undefined): string | undefined {
	if (!path?.trim()) return undefined;
	try {
		return getLanguageFromPath(path.replace(/^@/, "").trim());
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

const SGR = /\x1b\[[0-9;:]*m/y;
const RESET = "\x1b[0m";

/** Whether an SGR sequence clears the background: a full reset or `49`. */
function clearsBackground(sequence: string): boolean {
	const params = sequence.slice(2, -1);
	return params === "" || params.split(/[;:]/).some((param) => param === "0" || param === "49");
}

/**
 * Lay painted text out as rows of exactly `width` columns, wrapped or cut
 * with an ellipsis. `background` is the background of the row, and `spans`
 * the columns of the text that take `emphasis` instead. Styles the text set
 * carry over to its wrapped rows, and each row ends in a full reset, which
 * the house box answers by restoring its own ground.
 */
export function layoutCell(
	text: string,
	width: number,
	options: {
		wrap: boolean;
		background?: string;
		emphasis?: string;
		spans?: readonly Span[];
		/** Columns of the text where a wrapped row starts (see `wrapBreaks`); without them rows break wherever they fill. */
		breaks?: readonly number[];
	},
): string[] {
	if (width <= 0) return [""];
	const { wrap, background = "", emphasis = "", spans = [], breaks = [] } = options;
	let nextBreak = 0;
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	let column = 0;
	/** Styles set since the last full reset, re-applied at the start of a wrapped row. */
	let styles: string[] = [];
	let shownBackground: string | undefined;
	const backgroundAt = (at: number) =>
		emphasis && spans.some((span) => at >= span.start && at < span.end) ? emphasis : background;
	const setBackground = (bg: string) => {
		if (bg === shownBackground) return;
		row += bg || "\x1b[49m";
		shownBackground = bg;
	};
	const endRow = () => {
		if (rowWidth < width) {
			setBackground(background);
			row += " ".repeat(width - rowWidth);
		}
		rows.push(`${row}${RESET}`);
		row = styles.join("");
		rowWidth = 0;
		shownBackground = undefined;
	};
	let index = 0;
	while (index < text.length) {
		SGR.lastIndex = index;
		const sequence = SGR.exec(text);
		if (sequence) {
			const code = sequence[0];
			row += code;
			if (code === RESET || code === "\x1b[m") styles = [];
			else if (code === "\x1b[39m") styles = styles.filter((style) => !style.startsWith("\x1b[38"));
			else if (code.startsWith("\x1b[38")) styles = [...styles.filter((style) => !style.startsWith("\x1b[38")), code];
			else styles.push(code);
			if (clearsBackground(code)) shownBackground = undefined;
			index = SGR.lastIndex;
			continue;
		}
		const point = text.codePointAt(index)!;
		const char = String.fromCodePoint(point);
		index += char.length;
		const cells = charWidth(char);
		if (wrap && column === breaks[nextBreak]) {
			nextBreak++;
			if (rowWidth > 0) endRow();
		}
		if (rowWidth + cells > width) {
			if (!wrap) {
				// Cut: the last column becomes an ellipsis.
				({ row, width: rowWidth } = cutTo(row, rowWidth, width - 1));
				shownBackground = undefined;
				setBackground(backgroundAt(column));
				row += "…";
				rowWidth++;
				rows.push(`${row}${" ".repeat(Math.max(0, width - rowWidth))}${RESET}`);
				return rows;
			}
			endRow();
		}
		if (cells > width) continue;
		setBackground(backgroundAt(column));
		row += char;
		rowWidth += cells;
		column += cells;
	}
	endRow();
	return rows;
}

/**
 * Where to start each wrapped row of plain `text` laid out `width` columns
 * wide: after the last whitespace that fits, so words stay whole, unless
 * that would leave the row under a third full, when the row breaks where it
 * fills. The columns are those `layoutCell` counts in the painted text.
 */
export function wrapBreaks(text: string, width: number): number[] {
	const breaks: number[] = [];
	if (width <= 0) return breaks;
	let rowStart = 0;
	let column = 0;
	let afterSpace = -1;
	for (const char of text) {
		const cells = charWidth(char);
		if (column + cells - rowStart > width) {
			const start = afterSpace > rowStart && afterSpace - rowStart >= width / 3 ? afterSpace : column;
			breaks.push(start);
			rowStart = start;
			afterSpace = -1;
		}
		column += cells;
		if (/\s/.test(char)) afterSpace = column;
	}
	return breaks;
}

/**
 * Drop visible characters from the end of a painted row until it is at most
 * `target` columns wide. A wide character can leave it a column narrower.
 */
function cutTo(row: string, rowWidth: number, target: number): { row: string; width: number } {
	let result = row;
	let width = rowWidth;
	while (width > target && result.length > 0) {
		const sequence = /\x1b\[[0-9;:]*m$/.exec(result);
		if (sequence) {
			result = result.slice(0, -sequence[0].length);
			continue;
		}
		const chars = Array.from(result);
		const last = chars.pop()!;
		width -= charWidth(last);
		result = chars.join("");
	}
	return { row: result, width };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export type DiffLayout = "split" | "unified" | "compact" | "summary";

const SPLIT_SEPARATOR = " │ ";
const MIN_SPLIT_COLUMN = 24;
const MIN_UNIFIED_WIDTH = 18;
const MIN_COMPACT_WIDTH = 8;

/**
 * The layout for a diff at `width`. A one-sided diff — only additions, such
 * as a new file, or only removals — stays in one column: with nothing to
 * compare, a second column would stand empty.
 */
export function chooseLayout(
	options: Pick<DiffViewOptions, "viewMode" | "splitMinWidth">,
	width: number,
	oneSided = false,
): DiffLayout {
	if (width < MIN_COMPACT_WIDTH) return "summary";
	if (width < MIN_UNIFIED_WIDTH) return "compact";
	const splitFits = !oneSided && width >= MIN_SPLIT_COLUMN * 2 + SPLIT_SEPARATOR.length;
	if (options.viewMode === "split" && splitFits) return "split";
	if (options.viewMode === "auto" && splitFits && width >= options.splitMinWidth) return "split";
	return "unified";
}

interface RenderContext {
	theme: Theme;
	options: DiffViewOptions;
	language: string | undefined;
	numberWidth: number;
	tints: { add: string; remove: string; addEmphasis: string; removeEmphasis: string };
	emphasis: WeakMap<DiffLine, Span[]>;
}

/** The gutter before the code: change marker, line number, divider. */
function gutter(context: RenderContext, kind: LineKind, line: number | undefined, continued: boolean): { text: string; width: number } {
	const { theme, options, numberWidth } = context;
	const { lineNumber, divider } = TOOL_OUTPUT_COLORS.diff;
	const marked = kind !== "context";
	const number = continued || line === undefined ? " ".repeat(numberWidth) : String(line).padStart(numberWidth);
	const numberText = paint(theme, marked ? codeColor(kind) : lineNumber, number);
	if (options.indicator === "bars") {
		const bar = marked ? paint(theme, codeColor(kind), "▌") : " ";
		return { text: `${bar} ${numberText} ${paint(theme, divider, "│")} `, width: numberWidth + 5 };
	}
	if (options.indicator === "classic") {
		const sign = marked && !continued ? paint(theme, codeColor(kind), kind === "add" ? "+" : "-") : " ";
		return { text: `${numberText} ${paint(theme, divider, "│")}${sign} `, width: numberWidth + 4 };
	}
	return { text: `${numberText} ${paint(theme, divider, "│")} `, width: numberWidth + 3 };
}

function tintOf(context: RenderContext, kind: LineKind): { background: string; emphasis: string } {
	const { tints } = context;
	if (kind === "add") return { background: tints.add, emphasis: tints.addEmphasis };
	if (kind === "remove") return { background: tints.remove, emphasis: tints.removeEmphasis };
	return { background: "", emphasis: "" };
}

/** One line in a cell of `width` columns: its gutter, then its code, on as many rows as wrapping needs. */
function lineRows(context: RenderContext, line: DiffLine, side: "old" | "new" | "unified", width: number): string[] {
	const number = side === "old" ? line.oldLine : side === "new" ? line.newLine : line.kind === "remove" ? line.oldLine : line.newLine;
	const first = gutter(context, line.kind, number, false);
	const codeWidth = width - first.width;
	if (codeWidth < 4) return compactRows(context, line, width);
	const { background, emphasis } = tintOf(context, line.kind);
	const plain = displayText(line.text);
	const code = layoutCell(paintCode(context.theme, plain, line.kind, context.language), codeWidth, {
		wrap: context.options.wordWrap,
		background,
		emphasis,
		spans: context.emphasis.get(line),
		breaks: context.options.wordWrap ? wrapBreaks(plain, codeWidth) : undefined,
	});
	const continued = gutter(context, line.kind, number, true);
	return code.map((row, index) => `${background}${(index === 0 ? first : continued).text}${row}`);
}

/** A line without line numbers: just its change marker and code. */
function compactRows(context: RenderContext, line: DiffLine, width: number): string[] {
	const { theme, options } = context;
	const marked = line.kind !== "context";
	const marker =
		options.indicator === "none"
			? ""
			: options.indicator === "bars"
				? marked ? `${paint(theme, codeColor(line.kind), "▌")} ` : "  "
				: marked ? `${paint(theme, codeColor(line.kind), line.kind === "add" ? "+" : "-")} ` : "  ";
	const markerWidth = marker ? 2 : 0;
	const { background, emphasis } = tintOf(context, line.kind);
	if (width - markerWidth < 1) return [layoutCell("", width, { wrap: false })[0]!];
	const plain = displayText(line.text);
	const code = layoutCell(paintCode(theme, plain, line.kind, context.language), width - markerWidth, {
		wrap: options.wordWrap,
		background,
		emphasis,
		spans: context.emphasis.get(line),
		breaks: options.wordWrap ? wrapBreaks(plain, width - markerWidth) : undefined,
	});
	return code.map((row, index) => `${background}${index === 0 ? marker : " ".repeat(markerWidth)}${row}`);
}

/** A cell with no line in it: the other side of a one-sided change. */
function blankCell(context: RenderContext, width: number): string {
	const { theme, numberWidth, options } = context;
	const divider = paint(theme, TOOL_OUTPUT_COLORS.diff.divider, "│");
	const lead = options.indicator === "bars" ? `  ${" ".repeat(numberWidth)} ` : `${" ".repeat(numberWidth)} `;
	const tail = options.indicator === "classic" ? "  " : " ";
	return layoutCell(`${lead}${divider}${tail}`, width, { wrap: false })[0]!;
}

/** Where unchanged lines were skipped. */
function skipRow(context: RenderContext, width: number): string {
	const { theme, numberWidth, options } = context;
	const lead = options.indicator === "bars" ? `  ${" ".repeat(numberWidth)} ` : `${" ".repeat(numberWidth)} `;
	return layoutCell(`${lead}${paint(theme, TOOL_OUTPUT_COLORS.diff.divider, "⋯")}`, width, { wrap: false })[0]!;
}

function unifiedRows(context: RenderContext, entries: readonly DiffEntry[], width: number): string[] {
	const rows: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "skip") rows.push(skipRow(context, width));
		else rows.push(...lineRows(context, entry, "unified", width));
	}
	return rows;
}

function splitRows(context: RenderContext, paired: readonly PairedRow[], width: number): string[] {
	const separator = paint(context.theme, TOOL_OUTPUT_COLORS.diff.divider, SPLIT_SEPARATOR);
	const leftWidth = Math.floor((width - SPLIT_SEPARATOR.length) / 2);
	const rightWidth = width - SPLIT_SEPARATOR.length - leftWidth;
	const header = (label: string, cellWidth: number) => {
		const lead = context.options.indicator === "bars" ? 2 : 0;
		return layoutCell(
			`${" ".repeat(lead)}${paint(context.theme, TOOL_OUTPUT_COLORS.diff.header, label.padStart(context.numberWidth))}`,
			cellWidth,
			{ wrap: false },
		)[0]!;
	};
	const rows = [`${header("old", leftWidth)}${separator}${header("new", rightWidth)}`];
	for (const row of paired) {
		if (row.skip) {
			rows.push(`${skipRow(context, leftWidth)}${separator}${skipRow(context, rightWidth)}`);
			continue;
		}
		const left = row.left ? lineRows(context, row.left, "old", leftWidth) : [];
		const right = row.right ? lineRows(context, row.right, "new", rightWidth) : [];
		for (let index = 0; index < Math.max(left.length, right.length, 1); index++) {
			rows.push(`${left[index] ?? blankCell(context, leftWidth)}${separator}${right[index] ?? blankCell(context, rightWidth)}`);
		}
	}
	return rows;
}

interface PreparedDiff {
	stats: { added: number; removed: number };
	paired: PairedRow[];
	emphasis: WeakMap<DiffLine, Span[]>;
	/** The largest line number, which sets the gutter's width. */
	largest: number;
}

const prepared = new WeakMap<readonly DiffEntry[], PreparedDiff>();

/** What a diff's layout needs regardless of width, worked out once per parsed diff. */
function prepare(entries: readonly DiffEntry[]): PreparedDiff {
	const cached = prepared.get(entries);
	if (cached) return cached;
	const paired = pairRows(entries);
	const emphasis = new WeakMap<DiffLine, Span[]>();
	for (const row of paired) {
		if (row.left?.kind !== "remove" || row.right?.kind !== "add") continue;
		const spans = changedSpans(displayText(row.left.text), displayText(row.right.text));
		if (spans.before.length > 0) emphasis.set(row.left, spans.before);
		if (spans.after.length > 0) emphasis.set(row.right, spans.after);
	}
	const largest = entries.reduce(
		(max, entry) => (entry.kind === "skip" ? max : Math.max(max, entry.oldLine ?? 0, entry.newLine ?? 0)),
		0,
	);
	const result = { stats: diffStats(entries), paired, emphasis, largest };
	prepared.set(entries, result);
	return result;
}

/**
 * Render a parsed diff at `width`. `path` names the file, for its language.
 * An empty diff renders nothing; a capped one ends in a notice.
 */
export function renderDiffRows(
	entries: readonly DiffEntry[],
	width: number,
	theme: Theme,
	options: DiffViewOptions,
	path?: string,
): string[] {
	if (width <= 0 || entries.length === 0) return [];
	const { stats, paired, emphasis, largest } = prepare(entries);
	const layout = chooseLayout(options, width, stats.added === 0 || stats.removed === 0);
	if (layout === "summary") {
		const { added, removed } = TOOL_OUTPUT_COLORS.group;
		const text = `${paint(theme, added, `+${stats.added}`)} ${paint(theme, removed, `-${stats.removed}`)}`;
		return [layoutCell(text, width, { wrap: false })[0]!];
	}
	const context: RenderContext = {
		theme,
		options,
		language: languageOf(path),
		numberWidth: Math.max(layout === "split" ? 3 : 2, String(largest).length),
		tints: {
			add: diffTint(theme, "add", "row"),
			remove: diffTint(theme, "remove", "row"),
			addEmphasis: diffTint(theme, "add", "emphasis"),
			removeEmphasis: diffTint(theme, "remove", "emphasis"),
		},
		emphasis,
	};
	const rows =
		layout === "split"
			? splitRows(context, paired, width)
			: layout === "compact"
				? entries.flatMap((entry) =>
						entry.kind === "skip" ? [skipRow({ ...context, numberWidth: 0 }, width)] : compactRows(context, entry, width),
					)
				: unifiedRows(context, entries, width);
	if (options.maxRows > 0 && rows.length > options.maxRows) {
		const notice = paint(theme, TOOL_OUTPUT_COLORS.result.notice, `display capped at ${options.maxRows} lines`);
		return [...rows.slice(0, options.maxRows), layoutCell(notice, width, { wrap: false })[0]!];
	}
	return rows;
}

/** A diff as a component, re-laid out only when its width changes. */
export function diffComponent(diff: string, theme: Theme, options: DiffViewOptions, path?: string): Component {
	const entries = parseDiff(diff);
	let cached: { width: number; rows: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (cached?.width !== width) cached = { width, rows: renderDiffRows(entries, width, theme, options, path) };
			return cached.rows;
		},
		invalidate(): void {
			cached = undefined;
		},
	};
}
