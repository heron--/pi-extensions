import type {
	CustomEditor as CustomEditorType,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { hostname as osHostname } from "node:os";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { refreshPricingOverridesForSession } from "../lib/pricing.ts";
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
	railVerbatim,
} from "../lib/box.ts";
import {
	contextFooterConfigFile,
	loadThinkingAnimatePreference,
	saveThinkingAnimatePreference,
	THINKING_SHEEN_STEP_MS,
	updateContextFooterConfig,
} from "../lib/thinking-colors.ts";
import {
	DEFAULT_HOSTNAME_SETTINGS,
	DEFAULT_LAYOUT,
	type HostnameSettings,
	type Layout,
	REGIONS,
	type Region,
	readFooterConfig,
} from "./config.ts";
import { createTokenTotalsCache, hostnameLabel, hostnameShown, type ItemData, itemId, renderItem, stripAnsi } from "./items.ts";
import { fitFramedRow, fitPlainRow, type ShownItem } from "./layout.ts";
import { sanitizeStatus } from "./status.ts";
import { PullRequestTracker } from "./pull-request.ts";

/** The plain footer's item separator; the framed runs use lib/box.ts. */
const RULE_RUN = 2;

/** Width of the two rails the frame steals from the editor's own render width. */
const FRAME_WIDTH = 2;
/** Columns of air between each rail and the input, paid for the same way. */
const GUTTER_X = 1;
/** Below this the frame cannot hold a rule plus an item, so plain mode takes over. */
const MIN_FRAMED_WIDTH = 24;

type Paint = (text: string) => string;
type Regions = Record<Region, ShownItem[]>;

/**
 * Whether a blank rail row separates the input from the rule.
 *
 * A terminal row is atomic, so this is a row or nothing. Hugging the rule to a
 * cell edge with `▔`/`▁` would free vertical space without spending a row, but
 * box-drawing `─` is inked at text height, which is what lets an item read as
 * a break in the line. Move the ink to the top of the cell and the label no
 * longer interrupts the rule, it sits beneath it.
 */
type Padding = "full" | "none";
const PADDINGS = new Set<Padding>(["full", "none"]);

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

/** Pull `↑ 3 more` out of a scroll marker so the frame can carry it as an item. */
function scrollNotice(theme: Theme, line: string): ShownItem | null {
	const match = /([↑↓])\s+(\d+)\s+more/.exec(stripAnsi(line));
	if (!match) return null;
	return { id: "scroll-notice", text: theme.fg("dim", `${match[1]} ${match[2]} more`) };
}

/**
 * Draws a continuous border around pi's prompt editor, with the layout's
 * regions set into the top and bottom runs of the rule. This is deliberately
 * not a widget: the labels are part of the prompt's own frame. The rule rows
 * themselves come from ../lib/box.ts — the shared house layout, so the prompt
 * frame, the recap box, and the user-message box are built from the same
 * generators.
 *
 * The editor is rendered narrow so the rails and their gutters have somewhere
 * to live. Prefixing full-width rows instead overflows the terminal, and pi
 * responds to an over-wide row by throwing out of `TuiMainScreen.doRender`.
 *
 * Returns the rows and the ids of the items that survived the width.
 */
function frameEditor(
	baseRender: (width: number) => string[],
	width: number,
	theme: Theme,
	paint: Paint,
	padding: Padding,
	regions: Regions,
): { lines: string[]; visible: Set<string> } {
	const visible = new Set<string>();
	const innerWidth = width - FRAME_WIDTH - GUTTER_X * 2;
	const lines = baseRender(innerWidth);
	if (lines.length < 2) return { lines, visible };

	// Pi appends its autocomplete rows after the editor's lower rule, so the
	// lower rule is the last rule row rather than the last row.
	let lowerRuleIndex = lines.length - 1;
	while (lowerRuleIndex > 0 && !isRuleRow(lines[lowerRuleIndex]!, innerWidth)) lowerRuleIndex--;
	if (lowerRuleIndex === 0) return { lines, visible };

	const hasUpperRule = isRuleRow(lines[0]!, innerWidth);
	const framed: string[] = [];
	const gutter = railVerbatim({ line: " ".repeat(innerWidth), paint, padX: GUTTER_X });
	const markVisible = (ids: string[]) => ids.forEach((id) => visible.add(id));

	// The upper rule: top-right is anchored, top-left takes what is left.
	const upperNotice = hasUpperRule ? scrollNotice(theme, lines[0]!) : null;
	const top = fitFramedRow(width, regions.topRight, [...(upperNotice ? [upperNotice] : []), ...regions.topLeft]);
	markVisible([...top.anchor.visible, ...top.body.visible]);
	framed.push(frameRuleRow(width, paint, CORNER_TOP_LEFT, CORNER_TOP_RIGHT, "left", top.body.texts, top.anchor.texts));

	if (padding === "full") framed.push(gutter);
	for (let index = hasUpperRule ? 1 : 0; index < lowerRuleIndex; index++) {
		framed.push(railVerbatim({ line: lines[index]!, paint, padX: GUTTER_X }));
	}
	if (padding === "full") framed.push(gutter);

	const lowerNotice = scrollNotice(theme, lines[lowerRuleIndex]!);
	const trailing = lines.slice(lowerRuleIndex + 1);
	if (trailing.length > 0) {
		// Keep the completion list inside the frame: the lower rule becomes a
		// divider and the bottom regions move below the list.
		framed.push(frameRuleRow(width, paint, TEE_LEFT, TEE_RIGHT, "right", lowerNotice ? [lowerNotice.text] : []));
		for (const line of trailing) framed.push(railVerbatim({ line, paint, padX: GUTTER_X }));
	}

	// The lower rule: bottom-left is anchored, bottom-right takes what is left.
	const bottom = fitFramedRow(width, regions.bottomLeft, [
		...(trailing.length === 0 && lowerNotice ? [lowerNotice] : []),
		...regions.bottomRight,
	]);
	markVisible([...bottom.anchor.visible, ...bottom.body.visible]);
	framed.push(frameRuleRow(width, paint, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT, "right", bottom.body.texts, [], bottom.anchor.texts));

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
	return { lines: [softTop, ...framed.map(ground), softBottom], visible };
}

/**
 * Plain mode: the layout as two rows, for when the terminal is too narrow to
 * frame. Replacing pi's footer and then declining to render is how the model
 * and context would vanish entirely on a narrow terminal.
 */
function renderPlainFooter(theme: Theme, width: number, regions: Regions): string[] {
	const separator = theme.fg("borderMuted", `  ${RULE.repeat(RULE_RUN)}  `);
	return [
		[...regions.topLeft, ...regions.topRight],
		[...regions.bottomLeft, ...regions.bottomRight],
	].map((items) => fitPlainRow(width, items).texts.join(separator));
}

/** The keys the layout's status items name. */
function statusKeysOf(layout: Layout): Map<string, Region> {
	const keys = new Map<string, Region>();
	for (const region of REGIONS) {
		for (const item of layout[region]) if (item.kind === "status") keys.set(item.key, region);
	}
	return keys;
}

function layoutSelects(layout: Layout, id: string): boolean {
	return REGIONS.some((region) => layout[region].some((item) => itemId(item) === id));
}

export default function contextFooterExtension(pi: ExtensionAPI): void {
	// Every piece of state lives here, not at module level: pi recreates the
	// extension on new/resume/fork and /reload, and a module can outlive that.
	let enabled = true;
	let installed = false;
	let padding: Padding = "full";
	/**
	 * Whether the `max` shimmer may animate at all. A machine preference rather
	 * than a session choice, so it persists; `/context-footer animate` flips it.
	 * One preference for the whole scheme — it governs the model picker's
	 * level-list gloss too — persisted through the shared lib helpers.
	 */
	let animate = true;
	let layout: Layout = DEFAULT_LAYOUT;
	let hostnameSettings: HostnameSettings = DEFAULT_HOSTNAME_SETTINGS;
	/** The machine's hostname, re-read with the configuration. */
	let machineHostname = "";

	/** The footer pi is currently showing, while this extension's footer is enabled. */
	let footer: { tui: TUI; provider: ReadonlyFooterDataProvider; cwd: string } | null = null;
	const pullRequests = new PullRequestTracker();
	const tokenTotals = createTokenTotalsCache();

	/** The TUI the shimmer's repaint loop drives, captured from the editor factory. */
	let tickerTui: TUI | null = null;
	/** The shimmer's repaint driver, held only while its label is on screen. */
	let sheenTicker: ReturnType<typeof setInterval> | null = null;

	/**
	 * Start or stop the shimmer's repaint loop to match whether its label is
	 * being drawn. Called from the editor's render: every transition that could
	 * show or hide the gloss — a level change, `/context-footer`, a resize, a
	 * model without reasoning, a layout reload — is followed by a render, so
	 * this one call keeps the ticker truthful without subscribing to anything.
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

	/** Look up pull requests only while the footer is enabled and its layout selects the item. */
	function syncPullRequestWatch(): void {
		const current = footer;
		if (!current || !layoutSelects(layout, "pull-request")) {
			pullRequests.watch(null);
			return;
		}
		pullRequests.watch({
			cwd: current.cwd,
			currentBranch: () => current.provider.getGitBranch(),
			onResolved: () => current.tui.requestRender(),
		});
	}

	/** Resolve the layout against current data: each region's available items, in order. */
	function resolveRegions(ctx: ExtensionContext, theme: Theme, animated: boolean): Regions {
		const provider = footer?.provider;
		const selectedStatusKeys = statusKeysOf(layout);
		const cwd = ctx.sessionManager.getCwd();
		const branch = provider?.getGitBranch() ?? null;
		const data: ItemData = {
			ctx,
			theme,
			branch,
			pullRequest: branch ? pullRequests.get(cwd, branch) : null,
			hostname: machineHostname,
			hostnameSettings,
			tokens: tokenTotals(ctx.sessionManager),
			statuses: provider?.getExtensionStatuses() ?? new Map(),
			selectedStatusKeys,
			animated,
		};
		const regions = {} as Regions;
		for (const region of REGIONS) {
			regions[region] = [];
			for (const item of layout[region]) {
				const text = renderItem(item, data);
				if (text !== null && visibleWidth(text) > 0) regions[region].push({ id: itemId(item), text });
			}
		}
		return regions;
	}

	function buildFooter(ctx: ExtensionContext) {
		return (tui: TUI, _theme: Theme, provider: ReadonlyFooterDataProvider) => {
			const self = { tui, provider, cwd: ctx.sessionManager.getCwd() };
			footer = self;
			syncPullRequestWatch();

			const unsubscribe = provider.onBranchChange(() => {
				pullRequests.sync();
				tui.requestRender();
			});

			return {
				dispose() {
					unsubscribe();
					// A footer built before this one was disposed owns the lookup now.
					if (footer !== self) return;
					footer = null;
					syncPullRequestWatch();
				},
				invalidate() {},
				render(width: number): string[] {
					// The frame carries the layout itself, unless it is not drawing.
					if (width >= MIN_FRAMED_WIDTH) return [];
					// No repaint ticker drives the plain rows, so the gloss never animates here.
					return renderPlainFooter(ctx.ui.theme, width, resolveRegions(ctx, ctx.ui.theme, false));
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
			// is where the gloss animates; plain mode draws it too, but never moving.
			tickerTui = tui;
			const editor = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const baseRender = editor.render.bind(editor);

			editor.render = (width: number): string[] => {
				// Too narrow for a rule plus a label: leave pi's own rows alone.
				if (!enabled || width < MIN_FRAMED_WIDTH) {
					syncSheenTicker(false);
					return baseRender(width);
				}

				// One predicate drives both the ticker and the gloss: the highlight
				// advances only while the ticker runs, so a gloss that is not being
				// driven never jumps to a new position on an unrelated render — it
				// stays pinned at the head of the label, as in plain mode.
				const animating = animate && !!ctx.model?.reasoning && ctx.thinkingLevel === "max";

				const theme = ctx.ui.theme;
				// The frame is chrome, not signal: it paints the theme's border
				// colour and does not follow pi's thinking-level tint, which can be
				// near-invisible where a theme maps thinkingOff to a rule shade —
				// the thinking item carries the thinking state. Bash mode is the one
				// exception: it keeps pi's tint, detected with the same predicate pi
				// applies on every text change ("!" at the head of the input),
				// because "you are about to run a shell command" is a frame-level
				// cue pi's own editor still has.
				const bashMode = editor.getText().trimStart().startsWith("!");
				const paint: Paint = bashMode
					? (editor.borderColor ?? ((text: string) => theme.fg("syntaxType", text)))
					: (text: string) => theme.fg("syntaxType", text);

				const framed = frameEditor(baseRender, width, theme, paint, padding, resolveRegions(ctx, theme, animating));
				// The ticker runs only while the thinking item is actually on screen.
				syncSheenTicker(animating && framed.visible.has("thinking"));
				return framed.lines;
			};

			return editor as CustomEditorType;
		});
	}

	/** Whether the current theme defines a color, for validating the layout's colors. */
	function themeHasColor(ctx: ExtensionContext, name: string): boolean {
		try {
			ctx.ui.theme.fg(name as ThemeColor, "");
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Configuration reload: re-read the owner configuration without touching
	 * the extension runtime. At session start an unusable layout falls back to
	 * the default; on a reload, the last valid one stays.
	 */
	function loadConfig(ctx: ExtensionContext, reloading: boolean): void {
		machineHostname = osHostname();
		animate = loadThinkingAnimatePreference();
		const load = readFooterConfig(contextFooterConfigFile(), (name) => themeHasColor(ctx, name));
		if (load.layout) layout = load.layout;
		else if (!reloading) layout = DEFAULT_LAYOUT;
		if (load.hostname) hostnameSettings = load.hostname;
		else if (!reloading) hostnameSettings = DEFAULT_HOSTNAME_SETTINGS;
		syncPullRequestWatch();

		if (load.problems.length > 0) {
			const fallback = load.layout ? "" : reloading ? " Kept the previous layout." : " Using the default layout.";
			ctx.ui.notify(`context-footer config: ${load.problems.join("; ")}.${fallback}`, "warning");
		}
	}

	/** Re-read only the hostname settings, for `/context-footer host`. */
	function reloadHostname(ctx: ExtensionContext): void {
		machineHostname = osHostname();
		const load = readFooterConfig(contextFooterConfigFile());
		if (load.hostname) hostnameSettings = load.hostname;
		const problems = load.hostname ? load.problems.filter((problem) => problem.startsWith("\"hostname")) : load.problems;
		if (problems.length > 0) ctx.ui.notify(`context-footer hostname: ${problems.join("; ")}`, "warning");
	}

	/**
	 * Status-key discovery: the statuses published right now and what selects
	 * each, plus status items whose status is not published. Read-only: it
	 * asks no producer for anything and selects nothing.
	 */
	function describeStatuses(): string {
		const statuses = footer?.provider.getExtensionStatuses() ?? new Map<string, string>();
		const selected = statusKeysOf(layout);
		const remaining = REGIONS.find((region) => layout[region].some((item) => item.kind === "remaining-statuses"));
		// Keys are opaque producer strings; keep them to one safe line.
		const show = (key: string) => JSON.stringify(sanitizeStatus(key, "normalized"));
		const lines = ["Published statuses:"];
		if (statuses.size === 0) lines.push("  none");
		for (const key of [...statuses.keys()].sort()) {
			const region = selected.get(key);
			const by = region ? `status item in ${region}` : remaining ? `remaining statuses in ${remaining}` : "not selected";
			lines.push(`  ${show(key)} — ${by}`);
		}
		const unpublished = [...selected].filter(([key]) => !statuses.has(key));
		if (unpublished.length > 0) {
			lines.push("Selected but not published:");
			for (const [key, region] of unpublished) lines.push(`  ${show(key)} — status item in ${region}`);
		}
		if (!footer) lines.push("(The footer is off; statuses are read while it is on.)");
		return lines.join("\n");
	}

	function describeHostname(): string {
		const label = hostnameLabel(hostnameSettings, machineHostname);
		const named = label === machineHostname ? machineHostname : `${machineHostname} as "${label}"`;
		const state = hostnameShown(hostnameSettings, machineHostname) ? "shown" : "hidden";
		const reason = hostnameSettings.match
			? `match /${hostnameSettings.match.source}/ ${hostnameSettings.match.test(machineHostname) ? "matches" : "does not match"}`
			: `switch is ${hostnameSettings.show ? "on" : "off"}`;
		return `Hostname ${named} is ${state} (${reason})`;
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshPricingOverridesForSession(ctx);
		// Nothing is drawn outside the TUI, so the configuration is not read there.
		if (ctx.mode !== "tui") return;
		loadConfig(ctx, false);
		install(ctx);
	});

	pi.on("session_shutdown", async () => {
		// The TUI is going away; a live interval would paint into it after the
		// session ends and pin the event loop open at quit.
		syncSheenTicker(false);
		footer = null;
		pullRequests.watch(null);
	});

	pi.registerCommand("context-footer", {
		description: "Toggle the context-footer border, reload its configuration, list statuses, set its padding, toggle the thinking shimmer, or show the hostname",
		handler: async (args, ctx) => {
			const [verb, value, ...extra] = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

			if (verb === "reload") {
				if (value !== undefined) {
					ctx.ui.notify("Usage: /context-footer reload", "warning");
					return;
				}
				loadConfig(ctx, true);
				ctx.ui.notify("Context footer configuration reloaded", "info");
				return;
			}

			if (verb === "statuses") {
				if (value !== undefined) {
					ctx.ui.notify("Usage: /context-footer statuses", "warning");
					return;
				}
				ctx.ui.notify(describeStatuses(), "info");
				return;
			}

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

			if (verb === "host" || verb === "hostname") {
				// Re-read first, so hand edits to the regex or nicknames apply
				// without a restart and the report reflects the file.
				reloadHostname(ctx);
				if (value === undefined || value === "reload") {
					ctx.ui.notify(describeHostname(), "info");
					return;
				}
				if (extra.length > 0 || (value !== "on" && value !== "off")) {
					ctx.ui.notify("Usage: /context-footer host [on|off|reload]", "warning");
					return;
				}
				const show = value === "on";
				const saved = updateContextFooterConfig((config) => {
					const current = config.hostname;
					const hostname = current && typeof current === "object" && !Array.isArray(current)
						? (current as Record<string, unknown>)
						: {};
					config.hostname = { ...hostname, show };
				});
				hostnameSettings = { ...hostnameSettings, show };
				const note = hostnameSettings.match
					? ` — but "hostname.match" is set and decides on its own`
					: "";
				ctx.ui.notify(
					saved
						? `Context footer hostname switch ${show ? "on" : "off"}${note}`
						: `Context footer hostname switch ${show ? "on" : "off"} for this session only (config file not writable)${note}`,
					"info",
				);
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
				ctx.ui.notify("Usage: /context-footer [on|off|reload|statuses|pad full|pad none|animate on|animate off|host on|host off]", "warning");
				return;
			}

			const nextEnabled = verb === "off" ? false : verb === "on" ? true : !enabled;
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Context footer is already ${enabled ? "on" : "off"}`, "info");
				return;
			}

			enabled = nextEnabled;
			// The editor wrapper stays installed but inert; the footer goes back to
			// pi so the session information does not simply disappear. Disposing
			// this footer stops its pull-request lookups.
			ctx.ui.setFooter(enabled ? buildFooter(ctx) : undefined);
			ctx.ui.notify(enabled ? "Context footer enabled" : "Context footer disabled", "info");
		},
	});
}
