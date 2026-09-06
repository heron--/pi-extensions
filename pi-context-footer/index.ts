import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	CustomEditor as CustomEditorType,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { estimateUsageCost } from "../lib/pricing.ts";

const ICON_MODEL = String.fromCodePoint(0xf068c);
const ICON_FOLDER = "\uf115";
const ICON_BRANCH = "\uf126";
const ICON_COST = "\uf155";
const ICON_GAUGE = "\uf1c0";

const GAUGE_WIDTH = 8;
const GAUGE_FILLED = "█";
const GAUGE_EMPTY = "░";
const GAUGE_WARN_PERCENT = 60;
const GAUGE_ALERT_PERCENT = 85;
const STATUS_KEYS = new Set(["background-tasks"]);

const RULE = "─";
const RAIL = "│";
const CORNER_TOP_LEFT = "╭";
const CORNER_TOP_RIGHT = "╮";
const CORNER_BOTTOM_LEFT = "╰";
const CORNER_BOTTOM_RIGHT = "╯";
const TEE_LEFT = "├";
const TEE_RIGHT = "┤";

/** Width of the two rails the frame steals from the editor's own render width. */
const FRAME_WIDTH = 2;
/** Rules on each side of a status item, so the run reads as broken, not ended. */
const RULE_RUN = 2;
/** `╭── ` before the first item, ` ──╮` after the last. */
const LEAD_WIDTH = 1 + RULE_RUN + 1;
const TRAIL_WIDTH = 1 + RULE_RUN + 1;
/** Below this the frame cannot hold a rule plus a segment, so it is skipped. */
const MIN_FRAMED_WIDTH = 24;

const THINKING_COLOR: Record<string, ThemeColor> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
};

// Matches pi-powerline-footer's high-thinking gradient exactly.
const RAINBOW_LEVELS = new Set(["high", "xhigh", "max"]);
const RAINBOW_COLORS = [
	"#b281d6", "#d787af", "#febc38", "#e4c00f",
	"#89d281", "#00afaf", "#178fb9", "#b281d6",
];

type Paint = (text: string) => string;

/**
 * Whether a blank rail row separates the input from the rule.
 *
 * A terminal row is atomic, so this is a row or nothing. Hugging the rule to a
 * cell edge with `▔`/`▁` would free vertical space without spending a row, but
 * box-drawing `─` is inked at text height, which is what lets a status item
 * read as a break in the line. Move the ink to the top of the cell and the
 * label no longer interrupts the rule, it sits beneath it.
 */
type Padding = "full" | "none";
const PADDINGS = new Set<Padding>(["full", "none"]);

function hexToAnsi(hex: string): string {
	const value = hex.slice(1);
	const red = Number.parseInt(value.slice(0, 2), 16);
	const green = Number.parseInt(value.slice(2, 4), 16);
	const blue = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function rainbow(text: string): string {
	let result = "";
	let colorIndex = 0;
	for (const character of text) {
		if (character === " " || character === ":") {
			result += character;
			continue;
		}
		result += `${hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!)}${character}`;
		colorIndex++;
	}
	return `${result}\x1b[0m`;
}

function thinkingLabel(theme: Theme, level: string): string {
	const text = `thinking:${level}`;
	if (RAINBOW_LEVELS.has(level)) return rainbow(text);
	return theme.fg(THINKING_COLOR[level] ?? "thinkingOff", text);
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDollars(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

interface CostTotals {
	input: number;
	output: number;
	cost: number;
	hasCost: boolean;
}

/**
 * Per-response cost, memoized on the message.
 *
 * This runs on every editor render — so on every keystroke — and a price
 * estimate is a dataset lookup that tries several candidate model ids. A
 * response's usage never changes once recorded, so pay for it once.
 */
const COST_CACHE = new WeakMap<AssistantMessage, number | null>();

function messageCost(message: AssistantMessage): number | null {
	const cached = COST_CACHE.get(message);
	if (cached !== undefined) return cached;

	const recorded = message.usage.cost.total;
	const cost = recorded > 0 ? recorded : (estimateUsageCost(message.model, message.usage)?.total ?? null);
	COST_CACHE.set(message, cost);
	return cost;
}

/** Sum recorded provider cost, or calculate public-list-price cost per response. */
function computeCostTotals(ctx: ExtensionContext): CostTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	let hasCost = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		output += message.usage.output;

		const messageTotal = messageCost(message);
		if (messageTotal !== null) {
			cost += messageTotal;
			hasCost = true;
		}
	}

	return { input, output, cost, hasCost };
}

function gaugeColor(percent: number): "success" | "warning" | "error" {
	if (percent >= GAUGE_ALERT_PERCENT) return "error";
	if (percent >= GAUGE_WARN_PERCENT) return "warning";
	return "success";
}

function renderGauge(theme: Theme, percent: number | null): string {
	if (percent === null) return theme.fg("dim", GAUGE_EMPTY.repeat(GAUGE_WIDTH));

	const clamped = Math.max(0, Math.min(100, percent));
	const filledCount = Math.round((clamped / 100) * GAUGE_WIDTH);
	return theme.fg(gaugeColor(clamped), GAUGE_FILLED.repeat(filledCount))
		+ theme.fg("dim", GAUGE_EMPTY.repeat(GAUGE_WIDTH - filledCount));
}

/** The upper border carries identity and current context health. */
function buildTopSegments(ctx: ExtensionContext, theme: Theme): string[] {
	const model = ctx.model?.name || ctx.model?.id || "no-model";
	const sessionCwd = ctx.sessionManager.getCwd();
	const cwd = basename(sessionCwd) || sessionCwd;
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = usage?.percent ?? null;
	const percentLabel = percent === null ? "?" : `${percent.toFixed(0)}%`;
	const gaugeTone = percent === null ? "dim" : gaugeColor(percent);

	const segments = [theme.fg("syntaxType", `${ICON_MODEL} ${model}`)];
	if (ctx.model?.reasoning && ctx.thinkingLevel) {
		segments.push(thinkingLabel(theme, ctx.thinkingLevel));
	}
	segments.push(theme.fg("syntaxFunction", `${ICON_FOLDER} ${cwd}`));
	segments.push(
		`${theme.fg(gaugeTone, ICON_GAUGE)} ${renderGauge(theme, percent)} ${theme.fg("text", `${percentLabel}/${formatTokens(contextWindow)}`)}`,
	);
	return segments;
}

/** The lower border carries branch, calculated cost, token totals, and task state. */
function buildBottomSegments(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider | undefined,
): string[] {
	const totals = computeCostTotals(ctx);
	const segments: string[] = [];
	const branch = footerData?.getGitBranch() ?? null;
	if (branch) segments.push(theme.fg("success", `${ICON_BRANCH} ${branch}`));

	if (totals.hasCost) {
		segments.push(theme.fg("warning", `${ICON_COST} ${formatDollars(totals.cost)}`));
	}
	if (totals.input || totals.output) {
		segments.push(theme.fg("syntaxNumber", `⇡${formatTokens(totals.input)} ⇣${formatTokens(totals.output)}`));
	}

	for (const [key, status] of footerData?.getExtensionStatuses() ?? []) {
		if (!STATUS_KEYS.has(key)) continue;
		// Statuses arrive pre-styled for pi's own footer — pi-background-tasks
		// ships a filled light-blue pill. Strip that and repaint so a borrowed
		// status reads as part of this border rather than a sticker on it.
		const plain = stripAnsi(status).trim();
		if (plain) segments.push(theme.fg("accent", plain));
	}
	return segments;
}

const ANSI_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the input here
	/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Pi's editor emits a full-width horizontal rule as its first and last row,
 * swapping in a `─── ↑ N more ───` marker when the input itself is scrolled.
 * Those two rows are the ones this extension turns into a framed border.
 */
function isRuleRow(line: string, width: number): boolean {
	const stripped = stripAnsi(line);
	if (visibleWidth(stripped) !== width) return false;
	if (!stripped.startsWith(RULE)) return false;
	return /^─+$/.test(stripped) || /[↑↓]/.test(stripped);
}

/** Pull `↑ 3 more` out of a scroll marker so the frame can carry it as a segment. */
function scrollNotice(theme: Theme, line: string): string | null {
	const match = /([↑↓])\s+(\d+)\s+more/.exec(stripAnsi(line));
	if (!match) return null;
	return theme.fg("dim", `${match[1]} ${match[2]} more`);
}

/**
 * One horizontal run of the frame: a continuous rule broken only by the
 * segments handed in. The result is always exactly `width` cells wide, which is
 * what keeps pi's render-width assertion from tearing the screen down.
 *
 * Callers pass a `width` of at least `MIN_FRAMED_WIDTH`.
 */
function buildBorderRow(
	width: number,
	paint: Paint,
	leftCorner: string,
	rightCorner: string,
	segments: string[],
): string {
	const present = segments.filter((segment) => segment.trim().length > 0);
	if (present.length === 0) {
		return paint(leftCorner + RULE.repeat(width - FRAME_WIDTH) + rightCorner);
	}

	const budget = width - LEAD_WIDTH - TRAIL_WIDTH;
	let body = present.join(paint(` ${RULE.repeat(RULE_RUN)} `));
	if (visibleWidth(body) > budget) body = truncateToWidth(body, budget, "…");

	// The trailing rule run stretches to fill whatever the items left over.
	const fill = width - LEAD_WIDTH - visibleWidth(body) - (TRAIL_WIDTH - RULE_RUN);
	return `${paint(leftCorner + RULE.repeat(RULE_RUN))} ${body}${paint(` ${RULE.repeat(fill)}${rightCorner}`)}`;
}

/** Close a rule row pi still owns (a scroll marker) without reflowing it. */
function railRow(line: string, paint: Paint): string {
	return `${paint(RAIL)}${line}${paint(RAIL)}`;
}

/**
 * Draws a continuous border around pi's prompt editor, with status items set
 * into the top and bottom runs of the rule. This is deliberately not a widget:
 * the labels are part of the prompt's own frame.
 *
 * The editor is rendered two columns narrow so the rails have somewhere to
 * live. Prefixing full-width rows instead overflows the terminal, and pi
 * responds to an over-wide row by throwing out of `TuiMainScreen.doRender`.
 */
function frameEditor(
	baseRender: (width: number) => string[],
	width: number,
	theme: Theme,
	paint: Paint,
	padding: Padding,
	topSegments: string[],
	bottomSegments: string[],
): string[] {
	const innerWidth = width - FRAME_WIDTH;
	const lines = baseRender(innerWidth);
	if (lines.length < 2) return lines;

	// Pi appends its autocomplete rows after the editor's lower rule, so the
	// lower rule is the last rule row rather than the last row.
	let lowerRuleIndex = lines.length - 1;
	while (lowerRuleIndex > 0 && !isRuleRow(lines[lowerRuleIndex]!, innerWidth)) lowerRuleIndex--;
	if (lowerRuleIndex === 0) return lines;

	const hasUpperRule = isRuleRow(lines[0]!, innerWidth);
	const framed: string[] = [];
	const gutter = railRow(" ".repeat(innerWidth), paint);

	const upperNotice = hasUpperRule ? scrollNotice(theme, lines[0]!) : null;
	framed.push(
		buildBorderRow(width, paint, CORNER_TOP_LEFT, CORNER_TOP_RIGHT, [
			...(upperNotice ? [upperNotice] : []),
			...topSegments,
		]),
	);

	if (padding === "full") framed.push(gutter);
	for (let index = hasUpperRule ? 1 : 0; index < lowerRuleIndex; index++) {
		framed.push(railRow(lines[index]!, paint));
	}
	if (padding === "full") framed.push(gutter);

	const lowerNotice = scrollNotice(theme, lines[lowerRuleIndex]!);
	const trailing = lines.slice(lowerRuleIndex + 1);
	if (trailing.length > 0) {
		// Keep the completion list inside the frame: the lower rule becomes a
		// divider and the status run moves below the list.
		framed.push(
			buildBorderRow(width, paint, TEE_LEFT, TEE_RIGHT, lowerNotice ? [lowerNotice] : []),
		);
		for (const line of trailing) framed.push(railRow(line, paint));
	}

	framed.push(
		buildBorderRow(width, paint, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT, [
			...(trailing.length === 0 && lowerNotice ? [lowerNotice] : []),
			...bottomSegments,
		]),
	);
	return framed;
}

export default function contextFooterExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let installed = false;
	let padding: Padding = "full";
	let footerData: ReadonlyFooterDataProvider | undefined;

	function install(ctx: ExtensionContext): void {
		// A second install would wrap this extension's own wrapper, nesting a
		// frame inside a frame and narrowing the editor twice.
		if (installed) return;
		installed = true;

		ctx.ui.setFooter((tui, _theme, provider) => {
			footerData = provider;
			const unsubscribe = provider.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const baseRender = editor.render.bind(editor);

			editor.render = (width: number): string[] => {
				// Too narrow for a rule plus a label: leave pi's own rows alone.
				if (!enabled || width < MIN_FRAMED_WIDTH) return baseRender(width);

				const theme = ctx.ui.theme;
				// Track the editor's own border color so the frame follows pi's
				// bash-mode and thinking-level tinting instead of fighting it.
				const paint: Paint = editor.borderColor ?? ((text: string) => theme.fg("border", text));

				return frameEditor(
					baseRender,
					width,
					theme,
					paint,
					padding,
					buildTopSegments(ctx, theme),
					buildBottomSegments(ctx, theme, footerData),
				);
			};

			return editor as CustomEditorType;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	pi.registerCommand("context-footer", {
		description: "Toggle the context-footer border, or set its padding",
		handler: async (args, ctx) => {
			const [verb, value, ...extra] = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

			if (verb === "pad" || verb === "padding") {
				if (value === undefined) {
					ctx.ui.notify(`Context footer padding is ${padding}`, "info");
					return;
				}
				if (extra.length > 0 || !PADDINGS.has(value as Padding)) {
					ctx.ui.notify(`Padding must be one of: ${[...PADDINGS].join(", ")}`, "warning");
					return;
				}
				padding = value as Padding;
				ctx.ui.notify(`Context footer padding set to ${padding}`, "info");
				return;
			}

			if (value !== undefined || (verb !== undefined && verb !== "on" && verb !== "off")) {
				ctx.ui.notify("Usage: /context-footer [on|off|pad full|pad none]", "warning");
				return;
			}

			const nextEnabled = verb === "off" ? false : verb === "on" ? true : !enabled;
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Context footer is already ${enabled ? "on" : "off"}`, "info");
				return;
			}

			enabled = nextEnabled;
			ctx.ui.notify(enabled ? "Context footer enabled" : "Context footer disabled", "info");
		},
	});
}
