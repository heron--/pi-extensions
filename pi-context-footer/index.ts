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
const BORDER_RULE = "─";
const GAUGE_WARN_PERCENT = 60;
const GAUGE_ALERT_PERCENT = 85;
const SEGMENT_SEPARATOR = "  ";
const STATUS_KEYS = new Set(["background-tasks"]);

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
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

interface CostTotals {
	input: number;
	output: number;
	cost: number;
	estimated: boolean;
	hasCost: boolean;
}

/** Sum recorded provider cost, or calculate public-list-price cost per response. */
function computeCostTotals(ctx: ExtensionContext): CostTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	let estimated = false;
	let hasCost = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		input += usage.input + usage.cacheRead + usage.cacheWrite;
		output += usage.output;

		if (usage.cost.total > 0) {
			cost += usage.cost.total;
			hasCost = true;
			continue;
		}

		const estimate = estimateUsageCost(message.model, usage);
		if (estimate) {
			cost += estimate.total;
			estimated = true;
			hasCost = true;
		}
	}

	return { input, output, cost, estimated, hasCost };
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

function joinSegments(theme: Theme, segments: string[]): string {
	return segments.join(theme.fg("borderAccent", SEGMENT_SEPARATOR));
}

/** The upper border carries identity and current context health. */
function buildTopContent(ctx: ExtensionContext, theme: Theme): string {
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
	return joinSegments(theme, segments);
}

/** The lower border carries branch, calculated cost, token totals, and task state. */
function buildBottomContent(ctx: ExtensionContext, theme: Theme, footerData: ReadonlyFooterDataProvider | undefined): string {
	const totals = computeCostTotals(ctx);
	const segments: string[] = [];
	const branch = footerData?.getGitBranch() ?? null;
	if (branch) segments.push(theme.fg("success", `${ICON_BRANCH} ${branch}`));

	if (totals.hasCost) {
		segments.push(theme.fg("warning", `${ICON_COST} ${formatDollars(totals.cost).slice(1)}`));
	}
	if (totals.input || totals.output) {
		segments.push(theme.fg("syntaxNumber", `⇡${formatTokens(totals.input)} ⇣${formatTokens(totals.output)}`));
	}

	for (const [key, status] of footerData?.getExtensionStatuses() ?? []) {
		if (STATUS_KEYS.has(key) && status.trim()) segments.push(status);
	}
	return joinSegments(theme, segments);
}

/**
 * Replaces an editor rule with a visible framed border containing status
 * content. This is deliberately not a widget: these labels are part of the
 * prompt's own top and bottom borders.
 */
function decorateBorderLine(
	content: string,
	width: number,
	position: "top" | "bottom",
	borderColor: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (!content || width < 8) return borderColor(BORDER_RULE.repeat(width));

	const leftRule = position === "top" ? "╭─ " : "╰─ ";
	const rightRule = position === "top" ? " ─╮" : " ─╯";
	const fixedWidth = visibleWidth(leftRule) + visibleWidth(rightRule);
	const availableWidth = Math.max(0, width - fixedWidth);
	// Avoid passing supplementary-plane Nerd Font glyphs through truncation
	// when the content already fits: older terminal-width libraries can mangle them.
	const paddedContent = `${content} `;
	const body = visibleWidth(paddedContent) <= availableWidth
		? paddedContent
		: truncateToWidth(paddedContent, availableWidth, "");
	const fillWidth = Math.max(0, availableWidth - visibleWidth(body));
	return `${borderColor(leftRule)}${body}${borderColor(BORDER_RULE.repeat(fillWidth) + rightRule)}`;
}

/** Add the requested left rail without changing Pi's cursor marker in the line. */
function decoratePromptLine(line: string, borderColor: (text: string) => string): string {
	return `${borderColor("│ ")}${line}`;
}

function isScrollIndicatorRow(line: string): boolean {
	return line.includes("↑") || line.includes("↓");
}

export default function contextFooterExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let footerData: ReadonlyFooterDataProvider | undefined;

	function install(ctx: ExtensionContext): void {
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
				const lines = baseRender(width);
				if (!enabled || lines.length === 0) return lines;

				// Pi appends completion rows after the editor. Leave that transient
				// surface entirely to Pi rather than mistaking its final row for our
				// lower prompt border.
				if (Reflect.get(editor as object, "autocompleteState") !== null) return lines;

				const theme = ctx.ui.theme;
				const borderColor = (text: string) => theme.fg("borderAccent", text);
				if (!isScrollIndicatorRow(lines[0]!)) {
					lines[0] = decorateBorderLine(buildTopContent(ctx, theme), width, "top", borderColor);
					// Full blank rows add vertical breathing room without touching input.
					lines.splice(1, 0, "");
				}

				const bottomIndex = lines.length - 1;
				if (bottomIndex > 0 && !isScrollIndicatorRow(lines[bottomIndex]!)) {
					for (let index = 2; index < bottomIndex; index++) {
						lines[index] = decoratePromptLine(lines[index]!, borderColor);
					}
					lines[bottomIndex] = decorateBorderLine(buildBottomContent(ctx, theme, footerData), width, "bottom", borderColor);
					lines.splice(bottomIndex, 0, "");
				}

				return lines;
			};

			return editor as CustomEditorType;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	pi.registerCommand("context-footer", {
		description: "Toggle the context-footer border decoration",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const nextEnabled = arg === "off" ? false : arg === "on" ? true : !enabled;
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Context footer is already ${enabled ? "on" : "off"}`, "info");
				return;
			}

			enabled = nextEnabled;
			ctx.ui.notify(enabled ? "Context footer enabled" : "Context footer disabled", "info");
		},
	});
}
