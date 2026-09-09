import type { AssistantMessage, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type {
	CustomEditor as CustomEditorType,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { estimateUsageCost } from "../lib/pricing.ts";
import {
	fgFromBg,
	groundRow,
	CORNER_BL as CORNER_BOTTOM_LEFT,
	CORNER_BR as CORNER_BOTTOM_RIGHT,
	CORNER_TL as CORNER_TOP_LEFT,
	CORNER_TR as CORNER_TOP_RIGHT,
	RULE,
	TEE_L as TEE_LEFT,
	TEE_R as TEE_RIGHT,
	frameRuleRow,
	isRuleRow,
	railRow,
} from "../lib/box.ts";
/** The plain footer's segment separator; the framed runs use lib/box.ts. */
const RULE_RUN = 2;
import {
	loadThinkingAnimatePreference,
	paintThinkingLevel,
	saveThinkingAnimatePreference,
	THINKING_SHEEN_STEP_MS,
} from "../lib/thinking-colors.ts";

const ICON_MODEL = String.fromCodePoint(0xf068c);
const ICON_FOLDER = "\uf115";
const ICON_BRANCH = "\uf126";
const ICON_GAUGE = "\uf1c0";
const ICON_LOCK = String.fromCodePoint(0xf033e); // nf-md-lock
const ICON_LOCK_OPEN = String.fromCodePoint(0xf033f); // nf-md-lock_open
const ICON_SESSION = String.fromCodePoint(0xf04f9); // nf-md-tag

const GAUGE_WIDTH = 8;
const GAUGE_FILLED = "█";
const GAUGE_EMPTY = "░";
const GAUGE_WARN_PERCENT = 60;
const GAUGE_ALERT_PERCENT = 85;
const WRITE_LOCK_STATUS_KEY = "write-lock";
const STATUS_KEYS = new Set(["background-tasks", WRITE_LOCK_STATUS_KEY]);

/** OSC 8: wraps a label so terminals treat it as a link to `url`. */
const LINK_OPEN = "\x1b]8;;";
const LINK_CLOSE = "\x1b]8;;\x07";

/** Width of the two rails the frame steals from the editor's own render width. */
const FRAME_WIDTH = 2;
/** Columns of air between each rail and the input, paid for the same way. */
const GUTTER_X = 1;
/** Below this the frame cannot hold a rule plus a segment, so it is skipped. */
const MIN_FRAMED_WIDTH = 24;

let footerData: ReadonlyFooterDataProvider | undefined;

/** The TUI the shimmer's repaint loop drives, captured from the editor factory. */
let tickerTui: TUI | null = null;
/** The shimmer's repaint driver, held only while its label is on screen. */
let sheenTicker: ReturnType<typeof setInterval> | null = null;

/**
 * Start or stop the shimmer's repaint loop to match whether its label is being
 * drawn. Called from the editor's render: every transition that could show or
 * hide the gloss — a level change, `/context-footer`, a resize, a model without
 * reasoning — is followed by a render, so this one call keeps the ticker
 * truthful without subscribing to anything.
 */
function syncSheenTicker(active: boolean): void {
	if (!active) {
		if (sheenTicker === null) return;
		clearInterval(sheenTicker);
		sheenTicker = null;
		return;
	}
	if (sheenTicker === null) {
		sheenTicker = setInterval(() => tickerTui?.requestRender(), THINKING_SHEEN_STEP_MS);
	}
}

/**
 * Whether the `max` shimmer may animate at all. A machine preference rather
 * than a session choice, so it persists; `/context-footer animate` flips it.
 * One preference for the whole scheme — it governs the model picker's
 * level-list gloss too — persisted through the shared lib helpers.
 */
let animate = true;

type Paint = (text: string) => string;

/**
 * Which end of a run the items sit at.
 *
 * The top run is left-aligned and the bottom run right-aligned, so the long
 * unbroken stretch of each rule falls on the opposite corner from the other's.
 * That reads as more room around the input than packing both runs left does.
 */
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

/**
 * The thinking-level label, painted with the shared scheme from
 * lib/thinking-colors.ts so it matches the model picker's level rows exactly —
 * except "off", which paints dim rather than the scheme's thinkingOff color.
 * Themes may map that color to rule shades meant for barely-visible
 * separators, and the frame itself is no longer thinking-tinted (see the
 * editor wrapper), so this badge is the off state's only announcement and
 * has to stay legible. The model picker's DeepSeek toggle rows paint "off"
 * dim for the same reason.
 */
function thinkingLabel(theme: Theme, level: ModelThinkingLevel, animated: boolean): string {
	if (level === "off") return theme.fg("dim", `thinking:${level}`);
	return paintThinkingLevel(theme, level, `thinking:${level}`, animated);
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
	// A gateway can expose a request alias in `model` and the model that
	// actually answered in `responseModel`; price the latter when it is there.
	const priced = message.responseModel ?? message.model;
	const cost = recorded > 0 ? recorded : (estimateUsageCost(priced, message.usage)?.total ?? null);
	COST_CACHE.set(message, cost);
	return cost;
}

/**
 * Sum every billed entry in the session, using pi's recorded cost where it has
 * one and a public-list-price estimate per response where it does not.
 *
 * This walks `getEntries()` rather than `getBranch()`, and counts the same
 * things pi's own `getUsageCostBreakdown` does: assistant responses, usage
 * reported by a tool, and the calls behind a compaction or a branch summary.
 * An abandoned branch was still billed, and only assistant responses carry a
 * model id, so everything else can only contribute its recorded cost.
 */
function computeCostTotals(ctx: ExtensionContext): CostTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	let hasCost = false;

	function add(usage: Usage, message: AssistantMessage | null): void {
		input += usage.input + usage.cacheRead + usage.cacheWrite;
		output += usage.output;

		const total = message ? messageCost(message) : (usage.cost.total > 0 ? usage.cost.total : null);
		if (total !== null) {
			cost += total;
			hasCost = true;
		}
	}

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (entry.usage) add(entry.usage, null);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			add(entry.message.usage, entry.message);
		} else if (entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage, null);
		}
	}

	return { input, output, cost, hasCost };
}

interface PullRequest {
	number: number;
	url: string;
}

const PR_LOOKUP_TIMEOUT_MS = 5_000;
const PR_BY_BRANCH = new Map<string, PullRequest | null>();
let prLookupBranch: string | null = null;

/**
 * Ask `gh` for the pull request on a branch, once per branch.
 *
 * A miss is cached too, so a branch without a PR does not spawn `gh` on every
 * branch change. Switching back to a branch re-reads the cache, so a PR opened
 * mid-session shows up on the next pi run rather than immediately.
 */
function lookupPullRequest(cwd: string, branch: string, onResolved: () => void): void {
	if (PR_BY_BRANCH.has(branch) || prLookupBranch === branch) return;
	prLookupBranch = branch;

	execFile(
		"gh",
		["pr", "view", branch, "--json", "number,url"],
		{ cwd, timeout: PR_LOOKUP_TIMEOUT_MS },
		(error, stdout) => {
			prLookupBranch = null;
			let found: PullRequest | null = null;
			if (!error) {
				try {
					const parsed = JSON.parse(stdout) as { number?: unknown; url?: unknown };
					if (typeof parsed.number === "number" && typeof parsed.url === "string") {
						found = { number: parsed.number, url: parsed.url };
					}
				} catch {
					// `gh` is missing, unauthenticated, or printed something else.
				}
			}
			PR_BY_BRANCH.set(branch, found);
			onResolved();
		},
	);
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

/** The session name as a right-anchored segment, or null when none is set. */
function sessionNameSegment(ctx: ExtensionContext, theme: Theme): string | null {
	const name = ctx.sessionManager.getSessionName();
	if (!name) return null;
	// `emphasisText` is a theme color pi's ThemeColor union does not know about
	// yet (the schema is lenient at runtime, so the cast is safe); it resolves to
	// claude pink in the frontier-funds theme.
	return theme.fg("emphasisText" as ThemeColor, `${ICON_SESSION} ${name}`);
}

/** The upper border carries identity and current context health. */
function buildTopSegments(ctx: ExtensionContext, theme: Theme, animated: boolean): string[] {
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
		segments.push(thinkingLabel(theme, ctx.thinkingLevel, animated));
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
	provider: ReadonlyFooterDataProvider | undefined,
): string[] {
	const totals = computeCostTotals(ctx);
	const segments: string[] = [];
	const branch = provider?.getGitBranch() ?? null;
	if (branch) {
		const pullRequest = PR_BY_BRANCH.get(branch);
		const label = `${ICON_BRANCH} ${branch}`;
		segments.push(theme.fg("success", label));
		if (pullRequest) {
			segments.push(
				`${LINK_OPEN}${pullRequest.url}\x07${theme.fg("mdLink", `#${pullRequest.number}`)}${LINK_CLOSE}`,
			);
		}
	}

	// The money glyph is itself a dollar sign, so `formatDollars` supplies the
	// only one the segment needs.
	if (totals.hasCost) {
		segments.push(theme.fg("accent", formatDollars(totals.cost)));
	}
	if (totals.input || totals.output) {
		segments.push(theme.fg("syntaxNumber", `⇡${formatTokens(totals.input)} ⇣${formatTokens(totals.output)}`));
	}

	for (const [key, status] of provider?.getExtensionStatuses() ?? []) {
		if (!STATUS_KEYS.has(key)) continue;
		// Statuses arrive pre-styled for pi's own footer — pi-background-tasks
		// ships a filled light-blue pill. Strip that and repaint so a borrowed
		// status reads as part of this border rather than a sticker on it.
		const plain = stripAnsi(status).trim();
		if (!plain) continue;
		if (key === WRITE_LOCK_STATUS_KEY) {
			// The published text (`write unlocked`) contains "locked", so the
			// open-lock test has to win.
			const icon = /unlock/i.test(plain) ? ICON_LOCK_OPEN : ICON_LOCK;
			segments.push(theme.fg("warning", `${icon} ${plain}`));
			continue;
		}
		segments.push(theme.fg("accent", plain));
	}
	return segments;
}

/** A CSI sequence, or an OSC/APC string up to its BEL or ST terminator. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Pi's editor emits a full-width horizontal rule as its first and last row,
 * swapping in a `─── ↑ N more ───` marker when the input itself is scrolled.
 * Those two rows are the ones this extension turns into a framed border.
 */
/** Pull `↑ 3 more` out of a scroll marker so the frame can carry it as a segment. */
function scrollNotice(theme: Theme, line: string): string | null {
	const match = /([↑↓])\s+(\d+)\s+more/.exec(stripAnsi(line));
	if (!match) return null;
	return theme.fg("dim", `${match[1]} ${match[2]} more`);
}

/**
 * Draws a continuous border around pi's prompt editor, with status items set
 * into the top and bottom runs of the rule. This is deliberately not a widget:
 * the labels are part of the prompt's own frame. The rule rows themselves
 * come from ../lib/box.ts — the shared house layout, so the prompt frame, the
 * recap box, and the user-message box are built from the same generators.
 *
 * The editor is rendered narrow so the rails and their gutters have somewhere
 * to live. Prefixing full-width rows instead overflows the terminal, and pi
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
	topTrail: string[],
): string[] {
	const innerWidth = width - FRAME_WIDTH - GUTTER_X * 2;
	const lines = baseRender(innerWidth);
	if (lines.length < 2) return lines;

	// Pi appends its autocomplete rows after the editor's lower rule, so the
	// lower rule is the last rule row rather than the last row.
	let lowerRuleIndex = lines.length - 1;
	while (lowerRuleIndex > 0 && !isRuleRow(lines[lowerRuleIndex]!, innerWidth)) lowerRuleIndex--;
	if (lowerRuleIndex === 0) return lines;

	const hasUpperRule = isRuleRow(lines[0]!, innerWidth);
	const framed: string[] = [];
	const gutter = railRow({ line: " ".repeat(innerWidth), paint, padX: GUTTER_X });

	const upperNotice = hasUpperRule ? scrollNotice(theme, lines[0]!) : null;
	framed.push(
		frameRuleRow(width, paint, CORNER_TOP_LEFT, CORNER_TOP_RIGHT, "left", [
			...(upperNotice ? [upperNotice] : []),
			...topSegments,
		], topTrail),
	);

	if (padding === "full") framed.push(gutter);
	for (let index = hasUpperRule ? 1 : 0; index < lowerRuleIndex; index++) {
		framed.push(railRow({ line: lines[index]!, paint, padX: GUTTER_X }));
	}
	if (padding === "full") framed.push(gutter);

	const lowerNotice = scrollNotice(theme, lines[lowerRuleIndex]!);
	const trailing = lines.slice(lowerRuleIndex + 1);
	if (trailing.length > 0) {
		// Keep the completion list inside the frame: the lower rule becomes a
		// divider and the status run moves below the list.
		framed.push(
			frameRuleRow(width, paint, TEE_LEFT, TEE_RIGHT, "right", lowerNotice ? [lowerNotice] : []),
		);
		for (const line of trailing) framed.push(railRow({ line, paint, padX: GUTTER_X }));
	}

	framed.push(
		frameRuleRow(width, paint, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT, "right", [
			...(trailing.length === 0 && lowerNotice ? [lowerNotice] : []),
			...bottomSegments,
		]),
	);
	// The prompt box sits on the same dark ground as the recap and
	// user-message boxes (userMessageBg), so all three read as one family.
	// groundRow re-asserts the ground after the full resets inside the row —
	// the badge's rainbow close, the editor's cursor styling — which a plain
	// wrap cannot survive.
	const ground = (row: string) => groundRow(row, theme.getBgAnsi("userMessageBg"));
	// Breathing room above the widget rule: a row of lower-quarter blocks
	// inked in the ground color, so the box fades in below the transcript
	// instead of starting at a hard rule. NOT grounded — its air is the
	// terminal's own background, only the ink carries the color.
	// theme.fg only accepts foreground (ThemeColor) names and throws on a
	// background-only one, so the ground's ANSI code is recolored by hand.
	const softTop = `${fgFromBg(theme.getBgAnsi("userMessageBg"))}${"▂".repeat(width)}\x1b[39m`;
	// The mirror at the bottom: upper blocks inked in the ground color, so
	// the box fades out above whatever follows instead of ending at a hard
	// rule. Also NOT grounded — same reasoning as the top.
	const softBottom = `${fgFromBg(theme.getBgAnsi("userMessageBg"))}${"▔".repeat(width)}\x1b[39m`;
	return [softTop, ...framed.map(ground), softBottom];
}

/**
 * The status as a plain footer, for when the frame is not drawing it.
 *
 * Replacing pi's footer and then declining to render is how the model, context
 * and cost vanish entirely on a terminal too narrow to frame.
 */
function renderPlainFooter(ctx: ExtensionContext, theme: Theme, width: number): string[] {
	const separator = theme.fg("borderMuted", `  ${RULE.repeat(RULE_RUN)}  `);
	// No repaint ticker drives the plain rows, so the gloss never animates here.
	const sessionName = sessionNameSegment(ctx, theme);
	const top = sessionName ? [...buildTopSegments(ctx, theme, false), sessionName] : buildTopSegments(ctx, theme, false);
	const rows = [top, buildBottomSegments(ctx, theme, footerData)];

	return rows.map((segments) => {
		const row = segments.filter((segment) => segment.trim().length > 0).join(separator);
		return visibleWidth(row) > width ? truncateToWidth(row, width, "…") + LINK_CLOSE : row;
	});
}

export default function contextFooterExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let installed = false;
	let padding: Padding = "full";

	function buildFooter(ctx: ExtensionContext) {
		return (tui: TUI, _theme: Theme, provider: ReadonlyFooterDataProvider) => {
			footerData = provider;

			const findPullRequest = () => {
				const branch = provider.getGitBranch();
				if (branch) {
					lookupPullRequest(ctx.sessionManager.getCwd(), branch, () => tui.requestRender());
				}
			};
			findPullRequest();

			const unsubscribe = provider.onBranchChange(() => {
				findPullRequest();
				tui.requestRender();
			});

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					// The frame carries the status itself, unless it is not drawing.
					if (width >= MIN_FRAMED_WIDTH) return [];
					return renderPlainFooter(ctx, ctx.ui.theme, width);
				},
			};
		};
	}

	function install(ctx: ExtensionContext): void {
		// A second install would wrap this extension's own wrapper, nesting a
		// frame inside a frame and narrowing the editor twice.
		if (installed) return;
		installed = true;

		ctx.ui.setFooter(buildFooter(ctx));

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			// The shimmer's repaint loop needs the TUI. The frame this factory wraps
			// is where the gloss animates; the narrow plain footer draws it too,
			// but never moving.
			tickerTui = tui;
			const editor = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const baseRender = editor.render.bind(editor);

			editor.render = (width: number): string[] => {
				// One predicate drives both the ticker and the gloss: the highlight
				// advances only while the ticker runs, so a gloss that is not being
				// driven never jumps to a new position on an unrelated render — it
				// stays pinned at the head of the label, as in the plain footer.
				const animated =
					enabled
						&& animate
						&& width >= MIN_FRAMED_WIDTH
						&& !!ctx.model?.reasoning
						&& ctx.thinkingLevel === "max";
				syncSheenTicker(animated);
				// Too narrow for a rule plus a label: leave pi's own rows alone.
				if (!enabled || width < MIN_FRAMED_WIDTH) return baseRender(width);

				const theme = ctx.ui.theme;
				// The frame is chrome, not signal: it paints the theme's border
				// colour and does not follow pi's thinking-level tint, which can be
				// near-invisible where a theme maps thinkingOff to a rule shade —
				// the badge in the top run carries the thinking state. Bash mode is
				// the one exception: it keeps pi's tint, detected with the same
				// predicate pi applies on every text change ("!" at the head of the
				// input), because "you are about to run a shell command" is a
				// frame-level cue pi's own editor still has.
				const bashMode = editor.getText().trimStart().startsWith("!");
				const paint: Paint = bashMode
					? (editor.borderColor ?? ((text: string) => theme.fg("syntaxType", text)))
					: (text: string) => theme.fg("syntaxType", text);

				return frameEditor(
					baseRender,
					width,
					theme,
					paint,
					padding,
					buildTopSegments(ctx, theme, animated),
					buildBottomSegments(ctx, theme, footerData),
					[sessionNameSegment(ctx, theme)].filter((s): s is string => s !== null),
				);
			};

			return editor as CustomEditorType;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		animate = loadThinkingAnimatePreference();
		if (ctx.mode === "tui") install(ctx);
	});

	pi.on("session_shutdown", async () => {
		// The TUI is going away; a live interval would paint into it after the
		// session ends and pin the event loop open at quit.
		syncSheenTicker(false);
	});

	pi.registerCommand("context-footer", {
		description: "Toggle the context-footer border, set its padding, or toggle the thinking shimmer",
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

			if (verb === "animate") {
				if (value === undefined) {
					ctx.ui.notify(`Context footer animation is ${animate ? "on" : "off"}`, "info");
					return;
				}
				if (extra.length > 0 || (value !== "on" && value !== "off")) {
					ctx.ui.notify("Usage: /context-footer animate [on|off]", "warning");
					return;
				}
				const nextAnimate = value === "on";
				if (nextAnimate === animate) {
					ctx.ui.notify(`Context footer animation is already ${animate ? "on" : "off"}`, "info");
					return;
				}
				animate = nextAnimate;
				// The command's own notify repaints, so the ticker re-syncs itself.
				ctx.ui.notify(
					saveThinkingAnimatePreference(animate)
						? `Context footer animation ${nextAnimate ? "enabled" : "disabled"}`
						: `Context footer animation ${nextAnimate ? "enabled" : "disabled"} for this session only (config file not writable)`,
					"info",
				);
				return;
			}

			if (value !== undefined || (verb !== undefined && verb !== "on" && verb !== "off")) {
				ctx.ui.notify("Usage: /context-footer [on|off|pad full|pad none|animate on|animate off]", "warning");
				return;
			}

			const nextEnabled = verb === "off" ? false : verb === "on" ? true : !enabled;
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Context footer is already ${enabled ? "on" : "off"}`, "info");
				return;
			}

			enabled = nextEnabled;
			// The editor wrapper stays installed but inert; the footer goes back to
			// pi so the session information does not simply disappear.
			ctx.ui.setFooter(enabled ? buildFooter(ctx) : undefined);
			ctx.ui.notify(enabled ? "Context footer enabled" : "Context footer disabled", "info");
		},
	});
}
