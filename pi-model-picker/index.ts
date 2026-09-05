/**
 * model-picker extension
 *
 * A two-stage picker that sets the model AND its reasoning level in one flow:
 *   Stage 1: pick a model (grouped by provider, type to filter)
 *   Stage 2: pick a thinking level supported by that model
 *
 * Both model and level are applied together when stage 2 completes.
 * Escape in stage 2 goes back to stage 1; escape in stage 1 cancels.
 *
 * Takes over /model (see interceptModelCommand) rather than registering its
 * own command — there is deliberately only one entry point.
 *
 * Usage:
 *   /model                  open the picker (replaces pi's builtin)
 *   /model sonnet           open with the filter prefilled
 *
 * Run with: pi -e ~/Projects/heron--/pi-extensions/pi-model-picker/index.ts
 * (or link it into .pi/extensions/ — see the workspace README)
 *
 * ---------------------------------------------------------------------------
 * Layout notes
 *
 * Rows are laid out as fixed-width cells so every column lines up down the
 * list. SelectList renders `label` in a "primary column" and `description`
 * in a second column that starts at a fixed offset, so we:
 *
 *   1. measure the widest id/provider once, up front (NOT per filter pass),
 *      so columns do not jitter while typing; and
 *   2. pin the primary column via min/maxPrimaryColumnWidth, so the
 *      description column starts at the same offset on every row.
 *
 * Colour is applied per glyph through the `truncatePrimary` hook rather than
 * by embedding ANSI in `label`, because theme.fg() resets the foreground only
 * (\x1b[39m). A nested colour therefore "unpaints" the rest of the line, so
 * anything we want reliably coloured we colour ourselves, explicitly.
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { formatPricing, getPricing } from "../lib/pricing.ts";

const ALL_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Maximum visible rows in the model list.
 *
 * Group headers occupy rows too, so this is not a model count — with 6 provider
 * groups, 12 rows showed only ~6 models. The list is also capped at runtime to
 * what the terminal can actually fit (see visibleRowsFor).
 */
const MAX_VISIBLE = 28;

/** Maximum visible rows in the thinking-level list (at most 7 levels). */
const MAX_VISIBLE_LEVELS = 7;

/**
 * Chrome around the model list: borders, title, blank lines, filter input,
 * detail panel, legend, and help line. Subtracted from the terminal height so
 * the list never pushes its own footer off-screen.
 */
const MODEL_CHROME_ROWS = 13;

/**
 * Rows available for the list, given the terminal height. ctx.ui.custom() gives
 * a width but not a height, so read it from the tty and fall back to a
 * conservative 24 lines when it is not reported.
 */
function visibleRowsFor(rowCount: number): number {
	const termRows = process.stdout.rows ?? 24;
	const room = Math.max(4, termRows - MODEL_CHROME_ROWS);
	return Math.max(1, Math.min(rowCount, MAX_VISIBLE, room));
}

/**
 * Theme colours this extension uses. Declared as a narrow subset so the
 * helpers below can accept the theme from ctx.ui.custom() without importing
 * the (non-exported) Theme class.
 */
type PickerColor =
	| "accent"
	| "text"
	| "muted"
	| "dim"
	| "success"
	| "warning"
	| "error"
	| "border"
	| "borderMuted"
	| "mdLink"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

interface PickerTheme {
	fg(color: PickerColor, text: string): string;
	bold(text: string): string;
	/** Raw SGR code for a colour, with no trailing reset. */
	getFgAnsi(color: PickerColor): string;
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Capability glyphs. Every glyph here is exactly ONE terminal cell wide —
 * verified with visibleWidth(). Do not swap in emoji or glyphs like "☰"/"⬛":
 * those measure 2 cells (or render double-width) and shear the columns.
 */
const ICON = {
	text: "≡", // stacked lines  → text input
	image: "▣", // framed square  → image input
	reasoning: "✦", // spark         → extended reasoning
	absent: "·", // capability not supported
	current: "●", // the model/level currently active
	gaugeOn: "▰",
	gaugeOff: "▱",
} as const;

const ICON_COLOR = {
	text: "success",
	image: "mdLink",
	reasoning: "thinkingHigh",
	/**
	 * The active model marker. Deliberately NOT "accent": SelectList paints the
	 * highlighted row accent, so an accent marker made "current" and "highlighted"
	 * indistinguishable. "warning" is yellow in both builtin themes, and clashes
	 * with none of the capability colours (green / blue / purple).
	 */
	current: "warning",
} as const;

/** Per-level colour, matching pi's own thinking-level palette. */
const LEVEL_COLOR = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

/** Relative reasoning effort per level, used to fill the gauge (0..6). */
const LEVEL_INTENSITY: Record<ModelThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

const GAUGE_WIDTH = 6;

/** Plain-language description of what each level buys you. */
const LEVEL_BLURB: Record<ModelThinkingLevel, string> = {
	off: "no extended reasoning — fastest",
	minimal: "a quick pass before answering",
	low: "light reasoning for simple work",
	medium: "balances reasoning against latency",
	high: "deep reasoning for hard problems",
	xhigh: "very deep reasoning — slower",
	max: "largest reasoning budget — slowest",
};

interface ModelEntry {
	model: Model<Api>;
	/** Thinking level pinned for this model by --models / enabledModels scoping. */
	pinnedLevel?: ModelThinkingLevel;
}

/**
 * Best-effort list of thinking levels supported by a model.
 *
 * - Non-reasoning models only ever use "off".
 * - Without a thinkingLevelMap, reasoning models support the standard
 *   levels through "high".
 * - With a thinkingLevelMap: null hides a level, a string enables it, and
 *   omitted keys follow provider defaults (standard through "high";
 *   "xhigh"/"max" unsupported unless explicitly mapped).
 *
 * pi.setThinkingLevel() clamps to real capabilities, so this only shapes
 * the picker; it never overrides provider behavior.
 */
export function supportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const map: ThinkingLevelMap | undefined = model.thinkingLevelMap;
	if (!map) return ["off", "minimal", "low", "medium", "high"];
	return ALL_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (typeof mapped === "string") return true;
		// Omitted key: standard levels default-supported, extended levels unsupported.
		return level !== "xhigh" && level !== "max";
	});
}

/**
 * Models available in this session. Prefers the session-scoped list
 * (mirrors the built-in /model picker, respects --models / enabledModels),
 * falling back to the whole available catalogue when nothing is scoped.
 */
export function getModelEntries(ctx: ExtensionContext): ModelEntry[] {
	const scoped = ctx.scopedModels ?? [];
	if (scoped.length > 0) {
		return scoped.map((s) => ({
			model: s.model as Model<Api>,
			pinnedLevel: s.thinkingLevel as ModelThinkingLevel | undefined,
		}));
	}
	const available = ctx.modelRegistry.getAvailable();
	return available.map((model) => ({ model }));
}

function modelId(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function sameModel(a: Model<Api> | undefined, b: Model<Api>): boolean {
	return !!a && a.provider === b.provider && a.id === b.id;
}

/* -------------------------------------------------------------------------- */
/* Formatting primitives                                                      */
/* -------------------------------------------------------------------------- */

/** Abbreviate a token count with a magnitude letter: 128000 → "128K", 1050000 → "1.05M". */
export function abbreviateContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${+(tokens / 1_000_000).toFixed(2)}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K`;
	}
	return `${tokens}`;
}

/**
 * Per-million-token pricing as "$in/$out", or null when neither pi nor the
 * genai-prices dataset knows this model. Estimates are prefixed "~".
 *
 * pi ZERO-FILLS cost when a model definition omits it, so `{input: 0,
 * output: 0}` means "unknown", NOT "free" — custom/gateway providers routinely
 * arrive that way. ../lib/pricing.ts handles that and falls back to the
 * dataset; null still means genuinely unknown.
 */
export function formatCost(model: Model<Api>): string | null {
	return formatPricing(getPricing(model));
}

/** Pad to an exact visible width (ANSI-safe). */
function padEndTo(text: string, width: number): string {
	const delta = width - visibleWidth(text);
	return delta > 0 ? text + " ".repeat(delta) : text;
}

/** Right-align to an exact visible width (ANSI-safe). */
function padStartTo(text: string, width: number): string {
	const delta = width - visibleWidth(text);
	return delta > 0 ? " ".repeat(delta) + text : text;
}

/**
 * Truncate PLAIN text to a visible width, emitting no escape sequences.
 *
 * Why not pi-tui's truncateToWidth? When it cuts, it wraps its ellipsis in a
 * FULL reset (\x1b[0m), which clears every attribute — colour, bold, underline
 * — not just the foreground. Embedding that in a cell means everything after
 * the cut renders unstyled, so a truncated row lost its colour mid-line while
 * untruncated rows kept it.
 *
 * Use this for plain cell content BEFORE colouring it; keep truncateToWidth for
 * whole lines that already contain ANSI (there it is the correct, ANSI-aware
 * tool, and the reset lands at end-of-line where nothing follows it).
 */
export function fitPlain(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const ell = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const budget = width - visibleWidth(ell);
	let out = "";
	let used = 0;
	for (const ch of text) {
		const cw = visibleWidth(ch);
		if (used + cw > budget) break;
		out += ch;
		used += cw;
	}
	return out + ell;
}

/** Prose list of what a model accepts, for the detail panel. */
function inputProse(model: Model<Api>): string {
	const input = model.input ?? ["text"];
	const names = input.map((type) => (type === "image" ? "images" : "text"));
	if (names.length === 1) return names[0]!;
	return `${names.slice(0, -1).join(", ")} + ${names[names.length - 1]}`;
}

/**
 * Three capability cells, space-separated → exactly 5 visible columns.
 * Unsupported capabilities render as a dim placeholder so the cell keeps its
 * width and the following columns stay aligned.
 */
export function capabilityIcons(model: Model<Api>, theme: PickerTheme): string {
	const input = model.input ?? ["text"];
	const cells = [
		input.includes("text")
			? theme.fg(ICON_COLOR.text, ICON.text)
			: theme.fg("dim", ICON.absent),
		input.includes("image")
			? theme.fg(ICON_COLOR.image, ICON.image)
			: theme.fg("dim", ICON.absent),
		model.reasoning
			? theme.fg(ICON_COLOR.reasoning, ICON.reasoning)
			: theme.fg("dim", ICON.absent),
	];
	return cells.join(" ");
}

/** Legend explaining the row glyphs. */
function iconLegend(theme: PickerTheme): string {
	return [
		`${theme.fg(ICON_COLOR.text, ICON.text)} ${theme.fg("dim", "text")}`,
		`${theme.fg(ICON_COLOR.image, ICON.image)} ${theme.fg("dim", "image")}`,
		`${theme.fg(ICON_COLOR.reasoning, ICON.reasoning)} ${theme.fg("dim", "reasoning")}`,
		`${theme.fg(ICON_COLOR.current, ICON.current)} ${theme.fg("dim", "current")}`,
	].join(theme.fg("dim", "   "));
}

/* -------------------------------------------------------------------------- */
/* Column geometry                                                            */
/* -------------------------------------------------------------------------- */

const MARKER_WIDTH = 1;
const ICONS_WIDTH = 5; // "≡ ▣ ✦"
const CTX_WIDTH = 6; // "1.05M", "200K"
const CELL_GAP = 2;
const ID_MIN = 16;
const ID_MAX = 34;
const PRICE_MIN = 4;
const PRICE_MAX = 14;
/**
 * Floor for the name cell in the description column. Below this the name is
 * dropped entirely rather than shown as a couple of useless characters.
 */
const NAME_MIN = 6;
/**
 * Columns SelectList consumes before the description starts, derived from its
 * renderItem(): descriptionStart = prefix(2) + contentWidth + spacing(2), and
 * it then reserves 2 more, giving
 *   remainingWidth = width - primaryColumnWidth - 4
 * Getting this wrong by one costs the final character — which is the ellipsis,
 * so the cut silently stops looking like a cut.
 */
const DESC_RESERVED = 4;

export interface ModelColumns {
	idWidth: number;
	/** Width of the pricing cell, so model names line up beside it. */
	priceWidth: number;
	/**
	 * True when at least one model has real pricing. When false, a cost column
	 * could only ever print the same placeholder on every row, so the space goes
	 * to the model name instead.
	 */
	hasPricing: boolean;
	/** Visible width of the composed primary cell group. */
	contentWidth: number;
	/** Width to pin SelectList's primary column to (content + its 2-col gap). */
	primaryColumnWidth: number;
}

/**
 * Measure columns ONCE across all entries. Doing this per filter pass would
 * make the columns jump around as the user types.
 */
export function computeModelColumns(entries: ModelEntry[]): ModelColumns {
	const widestId = entries.reduce((w, e) => Math.max(w, visibleWidth(e.model.id)), 0);
	const idWidth = Math.min(Math.max(widestId, ID_MIN), ID_MAX);
	const hasPricing = entries.some((e) => getPricing(e.model) !== null);
	const widestPrice = entries.reduce(
		(w, e) => Math.max(w, visibleWidth(formatCost(e.model) ?? "—")),
		0,
	);
	const priceWidth = Math.min(Math.max(widestPrice, PRICE_MIN), PRICE_MAX);
	const contentWidth =
		MARKER_WIDTH + CELL_GAP + ICONS_WIDTH + CELL_GAP + idWidth + CELL_GAP + CTX_WIDTH;
	return {
		idWidth,
		priceWidth,
		hasPricing,
		contentWidth,
		// SelectList reserves a 2-column gap inside the primary column.
		primaryColumnWidth: contentWidth + CELL_GAP,
	};
}

/**
 * Compose the primary cell group for a model row, degrading gracefully as the
 * terminal narrows: drop the context column first, then the icons.
 *
 * Every visible glyph is coloured explicitly here. SelectList wraps the
 * selected row in selectedText(), but because theme.fg() resets foreground
 * only, an inner colour would otherwise unpaint everything after it.
 */
export function composeModelPrimary(
	entry: ModelEntry,
	opts: {
		isSelected: boolean;
		isCurrent: boolean;
		maxWidth: number;
		theme: PickerTheme;
		columns: ModelColumns;
	},
): string {
	const { isSelected, isCurrent, maxWidth, theme, columns } = opts;
	const model = entry.model;

	// SelectList wraps the selected row in selectedText() (accent). Our inner
	// theme.fg() calls end with a foreground-only reset (\x1b[39m), which would
	// leave the description column unpainted, so re-assert accent at the end of
	// the cell group. This is zero-width and survives SelectList's truncation.
	const tail = isSelected ? theme.getFgAnsi("accent") : "";

	const marker = isCurrent ? theme.fg(ICON_COLOR.current, ICON.current) : " ";
	// On the highlighted row, leave the id to SelectList's accent rather than
	// repainting it: an explicit colour here overrode the highlight, so moving the
	// cursor changed nothing visible. "current" gets yellow (the marker colour) so
	// it stays distinguishable from the highlight.
	const idColor: PickerColor = isSelected ? "accent" : isCurrent ? "warning" : "text";
	const ctx = theme.fg("muted", padStartTo(abbreviateContextWindow(model.contextWindow), CTX_WIDTH));

	// Widest → narrowest layouts; pick the first that fits.
	const overheadFull = MARKER_WIDTH + CELL_GAP + ICONS_WIDTH + CELL_GAP + CELL_GAP + CTX_WIDTH;
	const overheadNoCtx = MARKER_WIDTH + CELL_GAP + ICONS_WIDTH + CELL_GAP;
	const overheadBare = MARKER_WIDTH + CELL_GAP;

	const gap = " ".repeat(CELL_GAP);

	if (maxWidth - overheadFull >= ID_MIN) {
		const idW = Math.min(columns.idWidth, maxWidth - overheadFull);
		const id = padEndTo(fitPlain(model.id, idW), idW);
		return [marker, capabilityIcons(model, theme), theme.fg(idColor, id), ctx].join(gap) + tail;
	}
	if (maxWidth - overheadNoCtx >= ID_MIN) {
		const idW = maxWidth - overheadNoCtx;
		const id = padEndTo(fitPlain(model.id, idW), idW);
		return [marker, capabilityIcons(model, theme), theme.fg(idColor, id)].join(gap) + tail;
	}
	const idW = Math.max(1, maxWidth - overheadBare);
	const id = fitPlain(model.id, idW);
	return [marker, theme.fg(idColor, id)].join(gap) + tail;
}

/**
 * Secondary column: pricing (padded so names align) then the model name.
 *
 * The provider is NOT repeated here — it's the group heading now, which is what
 * freed this space up for the name.
 *
 * Returned as PLAIN text with no escape sequences: SelectList themes this
 * column as a whole, and an inner colour or reset would break that styling for
 * the remainder of the line.
 *
 * `totalWidth` is the terminal width. The name is sized to the space that
 * actually remains, because SelectList hard-chops an over-long description with
 * no ellipsis; ellipsizing it ourselves keeps the cut deliberate.
 */
export function composeModelDescription(
	entry: ModelEntry,
	columns: ModelColumns,
	totalWidth?: number,
): string {
	const available =
		totalWidth === undefined
			? Number.POSITIVE_INFINITY
			: Math.max(0, totalWidth - columns.primaryColumnWidth - DESC_RESERVED);

	const name = entry.model.name;
	if (!columns.hasPricing) {
		return Number.isFinite(available) ? fitPlain(name, available) : name;
	}

	const price = padEndTo(formatCost(entry.model) ?? "—", columns.priceWidth);
	const full = `${price}  ${name}`;
	if (visibleWidth(full) <= available) return full;

	// Must fit `available` exactly: anything longer gets hard-chopped by
	// SelectList with no ellipsis (and a full reset injected at the cut).
	const nameWidth = available - columns.priceWidth - 2;
	if (nameWidth >= NAME_MIN) return `${price}  ${fitPlain(name, nameWidth)}`;
	return fitPlain(price.trimEnd(), available);
}

/* -------------------------------------------------------------------------- */
/* Provider grouping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sentinel prefix for header row values. A model id can never collide with it
 * because it starts with NUL.
 */
const HEADER_VALUE = "\u0000header:";

type PickerRow =
	| { kind: "header"; provider: string; count: number; value: string }
	| { kind: "model"; entry: ModelEntry; value: string };

/**
 * Filtered entries grouped under a per-provider header row.
 *
 * Provider order follows first appearance in the registry (which respects
 * --models / enabledModels ordering) rather than being alphabetised, and models
 * keep their original order within a group. Headers are recomputed per filter
 * pass so a provider whose models all filter out drops its heading too.
 */
export function groupRows(entries: ModelEntry[], filter: string): PickerRow[] {
	const order: string[] = [];
	const byProvider = new Map<string, ModelEntry[]>();
	for (const entry of entries) {
		if (!matchesFilter(entry, filter)) continue;
		const provider = entry.model.provider;
		let group = byProvider.get(provider);
		if (!group) {
			group = [];
			byProvider.set(provider, group);
			order.push(provider);
		}
		group.push(entry);
	}

	const rows: PickerRow[] = [];
	for (const provider of order) {
		const group = byProvider.get(provider) ?? [];
		rows.push({
			kind: "header",
			provider,
			count: group.length,
			value: HEADER_VALUE + provider,
		});
		for (const entry of group) {
			rows.push({ kind: "model", entry, value: modelId(entry.model) });
		}
	}
	return rows;
}

/**
 * A group heading: provider name, a rule out to the right edge, and the number
 * of models in the group. The rule is the visual separator between groups.
 *
 * Returns at most `maxWidth` visible columns.
 */
export function composeGroupHeader(
	provider: string,
	count: number,
	maxWidth: number,
	theme: PickerTheme,
): string {
	if (maxWidth <= 0) return "";
	const countText = String(count);
	// label + " " + rule + " " + count === maxWidth
	// The floor is clamped to maxWidth: on a very narrow terminal a bare floor
	// would let the label alone exceed the budget and overflow the line.
	const labelBudget = Math.min(maxWidth, Math.max(4, maxWidth - visibleWidth(countText) - 6));
	const label = fitPlain(provider, labelBudget);
	const ruleWidth = maxWidth - visibleWidth(label) - visibleWidth(countText) - 2;
	const head = theme.fg("accent", theme.bold(label));
	if (ruleWidth < 3) return head;
	return `${head} ${theme.fg("borderMuted", "─".repeat(ruleWidth))} ${theme.fg("dim", countText)}`;
}

/* -------------------------------------------------------------------------- */
/* Detail panel                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Two-line summary of the highlighted model, shown under the list. This is
 * the "what am I about to pick" panel: real numbers, not restated labels.
 */
function modelDetailLines(entry: ModelEntry, theme: PickerTheme, width: number): string[] {
	const model = entry.model;
	const cost = formatCost(model);
	const facts = [
		`${abbreviateContextWindow(model.contextWindow)} context`,
		`${abbreviateContextWindow(model.maxTokens)} max output`,
		// "~" marks a genai-prices estimate rather than pi's own figure.
		cost ? `${cost} per Mtok${cost.startsWith("~") ? " (est.)" : ""}` : "no pricing available",
		`accepts ${inputProse(model)}`,
	];
	if (entry.pinnedLevel) facts.push(`pinned to ${entry.pinnedLevel}`);

	const sep = theme.fg("dim", " · ");
	return [
		truncateToWidth(`  ${theme.fg("text", theme.bold(model.name))}`, width, "…"),
		truncateToWidth(
			`  ${theme.fg("muted", modelId(model))}${sep}${theme.fg("muted", facts.join(" · "))}`,
			width,
			"…",
		),
	];
}

/** Substring filter across provider/id and display name. */
function matchesFilter(entry: ModelEntry, filter: string): boolean {
	if (!filter) return true;
	const q = filter.toLowerCase();
	return (
		modelId(entry.model).toLowerCase().includes(q) ||
		(entry.model.name ?? "").toLowerCase().includes(q)
	);
}

/* -------------------------------------------------------------------------- */
/* Stage 1: model picker                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Stage 1: model picker with a type-to-filter input above a SelectList.
 * Returns the chosen entry, or null when cancelled.
 */
function pickModel(
	ctx: ExtensionContext,
	entries: ModelEntry[],
	initialFilter: string,
): Promise<ModelEntry | null> {
	const current = ctx.model as Model<Api> | undefined;
	const columns = computeModelColumns(entries);

	return ctx.ui.custom<ModelEntry | null>((tui, theme, _kb, done) => {
		const input = new Input();
		if (initialFilter) input.setValue(initialFilter);

		// Rows currently rendered (headers + models), and a value -> row index map.
		let rows: PickerRow[] = [];
		let selectList: SelectList | null = null;
		// Descriptions are width-dependent, so rebuild when the terminal resizes.
		let lastWidth: number | undefined;
		// Track the highlighted value so filtering does not reset the cursor.
		let selectedValue = current ? modelId(current) : "";

		function rebuildList(totalWidth?: number) {
			if (totalWidth !== undefined) lastWidth = totalWidth;
			rows = groupRows(entries, input.getValue());
			if (rows.length === 0) {
				selectList = null;
				return;
			}
			const items: SelectItem[] = rows.map((row) =>
				row.kind === "header"
					? // No description: SelectList then takes its single-column path and
						// leaves the whole line to truncatePrimary, which is what lets a
						// header span the full width.
						{ value: row.value, label: row.provider }
					: {
							value: row.value,
							// Plain text: the coloured version comes from truncatePrimary.
							label: `${row.entry.model.id} ${abbreviateContextWindow(row.entry.model.contextWindow)}`,
							description: composeModelDescription(row.entry, columns, lastWidth),
						},
			);
			const list = new SelectList(
				items,
				visibleRowsFor(items.length),
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
				{
					// Pin the primary column so the description column starts at
					// the same offset on every row, regardless of the filter.
					minPrimaryColumnWidth: columns.primaryColumnWidth,
					maxPrimaryColumnWidth: columns.primaryColumnWidth,
					truncatePrimary: ({ item, isSelected, maxWidth }) => {
						const row = rows.find((r) => r.value === item.value);
						if (!row) return item.label;
						if (row.kind === "header") {
							return composeGroupHeader(row.provider, row.count, maxWidth, theme);
						}
						return composeModelPrimary(row.entry, {
							isSelected,
							isCurrent: sameModel(current, row.entry.model),
							maxWidth,
							theme,
							columns,
						});
					},
				},
			);

			// Land the highlight on a model, never a header: prefer the previously
			// highlighted model, else the current model, else the first model.
			const modelIdx = (v: string) =>
				rows.findIndex((r) => r.kind === "model" && r.value === v);
			let idx = selectedValue ? modelIdx(selectedValue) : -1;
			if (idx < 0 && current) idx = modelIdx(modelId(current));
			if (idx < 0) idx = rows.findIndex((r) => r.kind === "model");
			if (idx >= 0) {
				list.setSelectedIndex(idx);
				selectedValue = rows[idx]!.value;
			}
			selectList = list;
		}

		/**
		 * Move the highlight by `delta`, skipping header rows and wrapping.
		 *
		 * SelectList's own up/down would stop on headers, so navigation is handled
		 * here and its index is driven via setSelectedIndex (which also carries the
		 * scroll window along).
		 */
		function step(delta: number) {
			if (!selectList || rows.length === 0) return;
			const start = rows.findIndex((r) => r.value === selectedValue);
			let i = start < 0 ? 0 : start;
			for (let n = 0; n < rows.length; n++) {
				i = (i + delta + rows.length) % rows.length;
				if (rows[i]?.kind === "model") {
					selectList.setSelectedIndex(i);
					selectedValue = rows[i]!.value;
					return;
				}
			}
		}

		rebuildList();

		function highlightedEntry(): ModelEntry | undefined {
			const row = rows.find((r) => r.value === selectedValue);
			return row?.kind === "model" ? row.entry : undefined;
		}

		return {
			// Forward focus to the filter input so IME candidate windows land
			// on the cursor instead of the top-left corner.
			get focused(): boolean {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number): string[] {
				const w = Math.max(1, width);
				// Re-fit the width-dependent description cells on resize.
				if (w !== lastWidth) rebuildList(w);
				const lines: string[] = [];
				const filterValue = input.getValue();

				lines.push(theme.fg("border", "─".repeat(w)));
				lines.push(
					truncateToWidth(
						`  ${theme.fg("accent", theme.bold("Select model"))}${theme.fg("dim", "  ·  type to filter by name, id, or provider")}`,
						w,
						"…",
					),
				);
				lines.push("");

				// Filter input (indented to line up with the row text).
				for (const line of input.render(Math.max(1, w - 4))) {
					lines.push(`  ${line}`);
				}
				lines.push("");

				if (selectList) {
					for (const line of selectList.render(w)) lines.push(line);
					const entry = highlightedEntry();
					if (entry) {
						lines.push("");
						for (const line of modelDetailLines(entry, theme, w)) lines.push(line);
					}
				} else {
					lines.push(
						truncateToWidth(
							`  ${theme.fg("warning", `No model matches "${filterValue}"`)}${theme.fg("dim", "  ·  backspace to widen the search")}`,
							w,
							"…",
						),
					);
				}

				lines.push("");
				lines.push(truncateToWidth(`  ${iconLegend(theme)}`, w, "…"));
				lines.push(
					truncateToWidth(
						`  ${theme.fg("dim", "↑↓ move   ⏎ choose level   esc cancel")}`,
						w,
						"…",
					),
				);
				lines.push(theme.fg("border", "─".repeat(w)));
				return lines;
			},
			invalidate() {
				// Colours are recomputed from `theme` on every render, so there is
				// nothing cached to drop here. Rebuild the list anyway so the
				// SelectList's own theme callbacks are refreshed.
				rebuildList(lastWidth);
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				// Navigation is handled here rather than delegated, so headers are
				// skipped and Enter can never resolve to one.
				if (matchesKey(data, Key.up)) {
					step(-1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					step(1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const entry = highlightedEntry();
					if (entry) done(entry);
					return;
				}
				// Everything else (typing, backspace, paste, cursor moves) edits the filter.
				input.handleInput(data);
				rebuildList(lastWidth);
				tui.requestRender();
			},
		};
	});
}

/* -------------------------------------------------------------------------- */
/* Stage 2: thinking level picker                                             */
/* -------------------------------------------------------------------------- */

/** Filled/empty gauge showing relative reasoning effort, in the level's colour. */
export function levelGauge(level: ModelThinkingLevel, theme: PickerTheme): string {
	const filled = LEVEL_INTENSITY[level];
	const empty = GAUGE_WIDTH - filled;
	return (
		(filled > 0 ? theme.fg(LEVEL_COLOR[level], ICON.gaugeOn.repeat(filled)) : "") +
		(empty > 0 ? theme.fg("dim", ICON.gaugeOff.repeat(empty)) : "")
	);
}

const LEVEL_NAME_WIDTH = 7; // "minimal"
const LEVEL_PRIMARY_CONTENT = GAUGE_WIDTH + CELL_GAP + LEVEL_NAME_WIDTH + CELL_GAP + MARKER_WIDTH;

/**
 * Stage 2: thinking-level picker for a chosen model.
 * Returns the chosen level, or null to go back to stage 1.
 */
function pickThinkingLevel(
	ctx: ExtensionContext,
	model: Model<Api>,
	preferred: ModelThinkingLevel | undefined,
): Promise<ModelThinkingLevel | null> {
	const levels = supportedThinkingLevels(model);
	const current = ctx.thinkingLevel as ModelThinkingLevel | undefined;
	const map = model.thinkingLevelMap;

	return ctx.ui.custom<ModelThinkingLevel | null>((tui, theme, _kb, done) => {
		const items: SelectItem[] = levels.map((level) => ({
			value: level,
			label: level,
			description: LEVEL_BLURB[level],
		}));

		const selectList = new SelectList(
			items,
			Math.min(items.length, MAX_VISIBLE_LEVELS),
			{
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
			{
				minPrimaryColumnWidth: LEVEL_PRIMARY_CONTENT + CELL_GAP,
				maxPrimaryColumnWidth: LEVEL_PRIMARY_CONTENT + CELL_GAP,
				truncatePrimary: ({ item, isSelected }) => {
					const level = item.value as ModelThinkingLevel;
					const isCurrent = level === current;
					const gap = " ".repeat(CELL_GAP);
					// See composeModelPrimary: re-assert accent so the selected row's
					// description is not left unpainted by our foreground-only resets.
					const tail = isSelected ? theme.getFgAnsi("accent") : "";
					return (
						[
							levelGauge(level, theme),
							theme.fg(LEVEL_COLOR[level], padEndTo(level, LEVEL_NAME_WIDTH)),
							isCurrent ? theme.fg("accent", ICON.current) : " ",
						].join(gap) + tail
					);
				},
			},
		);
		selectList.onSelect = (item) => done(item.value as ModelThinkingLevel);
		selectList.onCancel = () => done(null);

		// Default selection: pinned level > current level > "high" > first.
		const defaultLevel =
			preferred ??
			(current && levels.includes(current) ? current : undefined) ??
			(levels.includes("high") ? "high" : undefined);
		const defaultIndex = defaultLevel ? levels.indexOf(defaultLevel) : -1;
		if (defaultIndex >= 0) selectList.setSelectedIndex(defaultIndex);

		return {
			render(width: number): string[] {
				const w = Math.max(1, width);
				const lines: string[] = [];

				lines.push(theme.fg("border", "─".repeat(w)));
				lines.push(
					truncateToWidth(
						`  ${theme.fg("accent", theme.bold("Reasoning effort"))}${theme.fg("dim", `  ·  for ${model.name}`)}`,
						w,
						"…",
					),
				);
				lines.push("");
				for (const line of selectList.render(w)) lines.push(line);

				// Detail panel: what this level actually sends to the provider.
				const selected = selectList.getSelectedItem();
				if (selected) {
					const level = selected.value as ModelThinkingLevel;
					const mapped = map?.[level];
					const detail =
						typeof mapped === "string"
							? `sends "${mapped}" to ${model.provider}`
							: `uses ${model.provider}'s default for this level`;
					lines.push("");
					lines.push(
						truncateToWidth(
							`  ${theme.fg(LEVEL_COLOR[level], level)}${theme.fg("dim", "  ·  ")}${theme.fg("muted", detail)}`,
							w,
							"…",
						),
					);
				}

				lines.push("");
				lines.push(
					truncateToWidth(
						`  ${theme.fg("dim", "↑↓ move   ⏎ apply   esc back to models")}`,
						w,
						"…",
					),
				);
				lines.push(theme.fg("border", "─".repeat(w)));
				return lines;
			},
			invalidate() {
				selectList.invalidate();
			},
			handleInput(data: string) {
				// SelectList handles up/down (wrapping), Enter (confirm), Esc/Ctrl+C (cancel).
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Apply model + thinking level together.
 */
async function applySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: Model<Api>,
	level: ModelThinkingLevel,
): Promise<void> {
	const success = await pi.setModel(model);
	if (!success) {
		ctx.ui.notify(`No API key for ${model.provider} — run /login to add one`, "error");
		return;
	}
	// Clamped to model capabilities; read back what was actually applied.
	pi.setThinkingLevel(level);
	const applied = pi.getThinkingLevel();
	const clamped = applied !== level ? ` (${level} not supported, clamped)` : "";
	ctx.ui.notify(`${model.name} · reasoning ${applied}${clamped}`, "info");
}

/** Shared flow for both /model-picker and the intercepted /model. */
async function runPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialFilter: string,
): Promise<void> {
	const entries = getModelEntries(ctx);
	if (entries.length === 0) {
		ctx.ui.notify("No models available — run /login to add a provider", "warning");
		return;
	}

	// Loop so Esc in stage 2 returns to stage 1 with the filter preserved.
	while (true) {
		const entry = await pickModel(ctx, entries, initialFilter);
		if (!entry) return; // cancelled in stage 1

		const level = await pickThinkingLevel(ctx, entry.model, entry.pinnedLevel);
		if (level === null) continue; // back to stage 1

		await applySelection(pi, ctx, entry.model, level);
		return;
	}
}

/**
 * Take over /model.
 *
 * pi will NOT let an extension register a command named "model": the name is in
 * BUILTIN_SLASH_COMMANDS, so it is dropped from autocomplete with a conflict
 * warning, and the TUI submit handler matches `/model` with a hardcoded `if`
 * before extensions are ever consulted.
 *
 * The editor is the seam. pi routes submitted text through
 * `editor.onSubmit`, and extensions may replace the editor entirely via
 * setEditorComponent(). Wrapping that handler puts us ahead of the builtin
 * check: we claim `/model`, and pass everything else through untouched.
 *
 * onSubmit is defined as an ACCESSOR rather than assigned, because pi assigns
 * it after the factory returns — reading it during construction (or on a
 * `setTimeout(0)`) captures undefined and the wrapper silently never fires.
 * The accessor wraps whatever pi assigns, whenever it assigns it.
 */
function interceptModelCommand(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const previousFactory = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		// Compose with any other extension's editor rather than clobbering it.
		const editor = previousFactory
			? previousFactory(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);

		let piSubmit: ((text: string) => void) | undefined;

		Object.defineProperty(editor, "onSubmit", {
			configurable: true,
			get() {
				return (text: string) => {
					const trimmed = text.trim();
					const isModel = trimmed === "/model" || trimmed.startsWith("/model ");
					if (!isModel) {
						piSubmit?.(text);
						return;
					}
					// "/model sonnet" prefills the filter, matching pi's own behaviour.
					const filter = trimmed.startsWith("/model ")
						? trimmed.slice("/model ".length).trim()
						: "";
					editor.setText("");
					void runPicker(pi, ctx, filter).catch((error: unknown) => {
						ctx.ui.notify(
							`model picker failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					});
				};
			},
			set(fn: (text: string) => void) {
				piSubmit = fn;
			},
		});

		return editor;
	});
}

export default function modelPickerExtension(pi: ExtensionAPI): void {
	// No pi.registerCommand("model-picker", ...) here: interceptModelCommand
	// below already gives us /model itself (see its own comment for why that's
	// the only way to get that exact name — pi refuses to let an extension
	// register a command literally called "model"). A second command
	// registered under a different name was pure redundancy: two entries in
	// autocomplete for the same picker. If interceptModelCommand ever breaks
	// (see AGENTS.md — it broke once already, silently, when pi-powerline-footer
	// discarded the editor it composed with), /model falls back to pi's
	// builtin rather than to this extension — there is no second command to
	// fall back to anymore. Confirm interception is actually running before
	// relying on this in a new environment.
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		interceptModelCommand(pi, ctx);
	});
}
