import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import type {
	CustomEditor as CustomEditorType,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "away-recap";
/**
 * Nerd Font's filled and hollow circle: what happened, and what has not
 * happened yet. A designed pair from one family, so they stay the same optical
 * size as each other whatever the terminal does with them.
 */
const MARKER_RECAP = "\uf111";
const MARKER_NEXT = "\uf10c";
const LABEL_RECAP = "Recap";
const LABEL_NEXT = "Next:";

/** Box drawing, matching the user-message frame `pi-tool-display` renders. */
const CORNER_TL = "╭";
const CORNER_TR = "╮";
const CORNER_BL = "╰";
const CORNER_BR = "╯";
const TEE_L = "├";
const TEE_R = "┤";
const RULE = "─";
const RAIL = "│";
/** A background applied per row survives an `\x1b[39m` but not an `\x1b[0m`. */
const BG_RESET = "\x1b[49m";
/** Columns of air inside the rails, and blank rows top and bottom. */
const PAD_X = 1;
const MIN_BOX_WIDTH = 24;

/**
 * Reply budgets, enforced here rather than trusted to the model.
 *
 * A cheap model told to write two sentences will sometimes write five, so the
 * prompt states the limits and the renderer clamps to them.
 */
const RECAP_MAX_CHARS = 500;
/** What to aim for. The ceiling is a backstop, not a goal. */
const RECAP_TARGET_CHARS = 200;
const NEXT_MAX_CHARS = 100;

/** `frame` draws the box; `clean` sets the same content flush left. */
type Style = "frame" | "clean";
const STYLES = new Set<Style>(["frame", "clean"]);

const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

const DEFAULT_THRESHOLD_MINUTES = 5;
const MIN_THRESHOLD_MINUTES = 0.05;
const MAX_THRESHOLD_MINUTES = 240;

/**
 * Every model in the rotation is a reasoning model, and thinking is drawn from
 * the same budget as the reply — 400 bought a recap that stopped mid-sentence.
 */
const RECAP_MAX_TOKENS = 2_000;
const RECAP_TIMEOUT_MS = 30_000;
/**
 * Never recap within this long of the agent going quiet, so a run someone
 * watched to the end is not immediately talked over. Capped by the threshold
 * itself, so a deliberately tiny threshold still fires promptly.
 */
const SETTLE_GRACE_MS = 8_000;
/** Digest budget. The tail is kept, because the newest activity matters most. */
const DIGEST_MAX_CHARS = 14_000;
const ENTRY_TEXT_MAX_CHARS = 500;
/** Marks where the user stopped typing, inside a whole-session digest. */
const AWAY_MARKER = "--- the user stepped away after this point ---";

/**
 * The rotation, cheapest-first, matched against the model catalogue by id.
 *
 * Patterns rather than `provider/id` pairs: the same model arrives under
 * different provider names depending on how the gateway is configured, and a
 * rotation entry that no longer resolves should drop out quietly rather than
 * break the rotation.
 */
const ROTATION_PATTERNS: RegExp[] = [
	/deepseek/i,
	/glm-5\.3-flash/i,
	/gemini-3\.8-flash/i,
	/gpt-5\.6-luna/i,
	/claude-haiku/i,
];

const RECAP_SYSTEM_PROMPT = [
	"You write the recap a developer reads when they sit back down at their terminal after stepping away.",
	"",
	"You are given a digest of their whole coding session. A marker line shows where they stopped",
	"typing and stepped away.",
	"",
	"You are speaking to the user. Be concise and word-efficient. Reply as exactly two lines, in",
	"this shape and nothing else:",
	"",
	`${LABEL_RECAP}: <a concise summary of the session and the most recent work, and where it stands now>`,
	`${LABEL_NEXT} <what is needed from them, and what is coming up>`,
	"",
	`Aim for about ${RECAP_TARGET_CHARS} characters on the ${LABEL_RECAP} line — ${RECAP_MAX_CHARS} is a hard ceiling, not a`,
	`target — and ${NEXT_MAX_CHARS} on the ${LABEL_NEXT} line.`,
	"",
	"This is read at a glance, so write for scanning. Say what the work was, not every step of it.",
	"One or two concrete anchors is plenty — a file, a PR, a command. Do not explain what a thing",
	"is, do not add parentheticals, do not list every file touched, and do not quote counts or",
	"output unless the number is the point.",
	"",
	`Both of these are ${LABEL_RECAP} content — the work, and the state it is in:`,
	'  "Building a new dashboard widget for the dash-viz library that visualizes activity per',
	'  model, polishing its look after your feedback."',
	'  "Everything sits in draft PR #5."',
	"",
	`${LABEL_NEXT} is what happens after this, not a description of the work:`,
	'  "Needs your call on the retry limit before the migration can run."',
	"",
	"Favour the part after the marker, since that is what they did not see. No preamble, no",
	"greeting, no sign-off, no bullet points, no markdown, no restating that they were away. Never",
	"invent anything that is not in the digest: if it does not give you a number, a filename, or a",
	"result, do not supply one.",
].join("\n");

interface RecapResult {
	text: string;
	modelName: string;
	stamp: string;
}

/** `5:00pm, August 12` */
function formatStamp(at: Date): string {
	const hours = at.getHours();
	const hour12 = hours % 12 || 12;
	const minutes = at.getMinutes().toString().padStart(2, "0");
	const meridiem = hours < 12 ? "am" : "pm";
	return `${hour12}:${minutes}${meridiem}, ${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

function clampMinutes(value: number): number {
	return Math.min(MAX_THRESHOLD_MINUTES, Math.max(MIN_THRESHOLD_MINUTES, value));
}

function formatMinutes(minutes: number): string {
	if (minutes >= 1) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
	return `${Math.round(minutes * 60)}s`;
}

function collapse(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Collapse a message but keep both ends.
 *
 * Keeping only the head loses the answer: a long reply opens with what it is
 * about — often a file it just dumped — and closes with the result. Cutting
 * from the front handed the recap a file listing with the line count removed,
 * and it filled the gap with a number of its own.
 */
function clampChars(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;

	const cut = flat.slice(0, limit);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function collapseEnds(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;

	const head = Math.floor(limit * 0.4);
	const tail = limit - head;
	return `${flat.slice(0, head)} … ${flat.slice(flat.length - tail)}`;
}

/**
 * Plain-text account of the session, with a marker where the user stepped away.
 *
 * Deliberately not the raw transcript: tool arguments and results are the bulk
 * of a session and almost none of what a recap needs, so each entry collapses
 * to one line naming what happened.
 */
function buildDigest(ctx: ExtensionContext, since: number): string[] {
	const lines: string[] = [];
	let awayMarked = false;
	let sawAwayActivity = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (Date.parse(entry.timestamp) >= since) {
			if (!awayMarked) {
				lines.push(AWAY_MARKER);
				awayMarked = true;
			}
			sawAwayActivity = true;
		}

		if (entry.type === "compaction") {
			lines.push("[system] context was compacted");
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (message.role === "assistant") {
			const said = message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join(" ");
			if (said.trim()) lines.push(`[agent] ${collapseEnds(said, ENTRY_TEXT_MAX_CHARS)}`);

			for (const part of message.content) {
				if (part.type === "toolCall") lines.push(`[tool] ran ${part.name}`);
			}
			if (message.errorMessage) lines.push(`[error] ${collapse(message.errorMessage, 200)}`);
			continue;
		}
		if (message.role === "toolResult" && message.isError) {
			lines.push(`[tool] ${message.toolName} failed`);
		}
		if (message.role === "user") {
			const said = typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
			if (said.trim()) lines.push(`[user] ${collapseEnds(said, ENTRY_TEXT_MAX_CHARS)}`);
		}
	}

	// Nothing happened while they were away, so there is nothing to catch up on.
	return sawAwayActivity ? lines : [];
}

function capDigest(lines: string[]): string {
	const joined = lines.join("\n");
	if (joined.length <= DIGEST_MAX_CHARS) return joined;
	return `…\n${joined.slice(joined.length - DIGEST_MAX_CHARS)}`;
}

/** Resolve the rotation against the catalogue, keeping only usable models. */
function resolveRotation(ctx: ExtensionContext): Model<Api>[] {
	const available = ctx.modelRegistry.getAvailable();
	const resolved: Model<Api>[] = [];

	for (const pattern of ROTATION_PATTERNS) {
		const match = available.find(
			(model) => pattern.test(model.id) && ctx.modelRegistry.hasConfiguredAuth(model),
		);
		if (match && !resolved.some((existing) => existing.id === match.id)) resolved.push(match);
	}
	return resolved;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * Split the reply into its two blocks, and drop the labels it wrote itself —
 * the renderer supplies those.
 *
 * A small model asked for two labelled lines will sometimes run them together
 * into one paragraph instead, so the label is looked for at a line start first
 * and anywhere in the text second.
 */
function splitNext(text: string): { body: string; next: string | null } {
	const anchored = new RegExp(`(?:^|\n)\\s*${LABEL_NEXT}\\s*`, "i").exec(text);
	const match = anchored ?? new RegExp(`\\s*${LABEL_NEXT}\\s*`, "i").exec(text);
	const stripRecap = (value: string) =>
		value.replace(new RegExp(`^\\s*${LABEL_RECAP}:?\\s*`, "i"), "").trim();

	if (!match) return { body: clampChars(stripRecap(text), RECAP_MAX_CHARS), next: null };

	const body = stripRecap(text.slice(0, match.index));
	const next = text.slice(match.index + match[0].length).trim();
	return {
		body: clampChars(body || stripRecap(text), RECAP_MAX_CHARS),
		next: next ? clampChars(next, NEXT_MAX_CHARS) : null,
	};
}

function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];

	for (const paragraph of text.split("\n")) {
		let row = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			const candidate = row ? `${row} ${word}` : word;
			if (visibleWidth(candidate) <= width) {
				row = candidate;
				continue;
			}
			if (row) rows.push(row);
			row = visibleWidth(word) > width ? truncateToWidth(word, width, "…") : word;
		}
		if (row) rows.push(row);
	}
	return rows;
}

/** The boxed treatment: label in the border, content on its own background. */
function renderFrame(theme: Theme, recap: RecapResult, width: number): string[] {
	if (width < MIN_BOX_WIDTH) return [];

	const { body, next } = splitNext(recap.text);
	// A row's background must be applied around the whole row: the fg
	// resets inside it are `\x1b[39m`, which leave a background alone.
	// The user-prompt background, so the recap sits on the same ground as the
	// messages around it — and it is the darker of the two, which the prose needs.
	const filled = (row: string) => `${theme.getBgAnsi("userMessageBg")}${row}${BG_RESET}`;
	const rule = (text: string) => theme.fg("border", text);
	const label = (text: string) => theme.bold(theme.fg("customMessageLabel", text));
	const prose = (text: string) => theme.italic(theme.fg("customMessageText", text));

	const inner = width - 2;
	const content = Math.max(1, inner - PAD_X * 2);
	const pad = " ".repeat(PAD_X);

	/** `│ …content… │`, padded so the background covers the full row. */
	const row = (text: string): string => {
		const gap = " ".repeat(Math.max(0, content - visibleWidth(text)));
		return filled(`${rule(RAIL)}${pad}${text}${gap}${pad}${rule(RAIL)}`);
	};

	const title = ` ${label(`${MARKER_RECAP} ${LABEL_RECAP}`)} `;
	const titleFill = RULE.repeat(Math.max(0, inner - visibleWidth(title)));
	const rows = [filled(`${rule(CORNER_TL)}${title}${rule(`${titleFill}${CORNER_TR}`)}`), row("")];

	for (const line of wrap(body, content)) rows.push(row(prose(line)));

	if (next) {
		// A rule across the box, so the two blocks read as two.
		rows.push(filled(rule(`${TEE_L}${RULE.repeat(inner)}${TEE_R}`)));

		// Marker and label sit flush left; the block's wrapped lines hang
		// under where its own text began.
		const head = `${MARKER_NEXT} ${LABEL_NEXT} `;
		const indent = " ".repeat(visibleWidth(head));
		for (const [index, line] of wrap(next, Math.max(1, content - visibleWidth(head))).entries()) {
			rows.push(
				row(index === 0 ? `${label(`${MARKER_NEXT} ${LABEL_NEXT}`)} ${prose(line)}` : `${indent}${prose(line)}`),
			);
		}
	}

	rows.push(row(""));

	// The attribution rides the bottom rule, the way pi-context-footer
	// sets status items into the prompt border.
	const stamp = ` generated by ${recap.modelName} at ${recap.stamp} `;
	const stampFill = inner - visibleWidth(stamp);
	rows.push(
		filled(
			stampFill >= 2
				? `${rule(`${CORNER_BL}${RULE.repeat(stampFill)}`)}${theme.fg("dim", stamp)}${rule(CORNER_BR)}`
				: rule(`${CORNER_BL}${RULE.repeat(inner)}${CORNER_BR}`),
		),
	);
	return rows;
}

/** Flush left, no box — the same content with nothing drawn around it. */
function renderClean(theme: Theme, recap: RecapResult, width: number): string[] {
	const { body, next } = splitNext(recap.text);
	const label = (text: string) => theme.bold(theme.fg("customMessageLabel", text));
	const prose = (text: string) => theme.italic(theme.fg("customMessageText", text));

	// Marker and label sit flush left; each block's wrapped lines hang under
	// where its own text began, so the indent resets between blocks.
	const block = (marker: string, labelText: string, text: string): string[] => {
		const head = `${marker} ${labelText} `;
		const indent = " ".repeat(visibleWidth(head));
		return wrap(text, Math.max(1, width - visibleWidth(head) - 2)).map((line, index) =>
			index === 0
				? `${label(`${marker} ${labelText}`)} ${prose(line)}`
				: `${indent}${prose(line)}`,
		);
	};

	return [
		...block(MARKER_RECAP, `${LABEL_RECAP}:`, body),
		...(next ? ["", ...block(MARKER_NEXT, LABEL_NEXT, next)] : []),
		theme.italic(theme.fg("dim", `generated by ${recap.modelName} at ${recap.stamp}`)),
	];
}

export default function awayRecapExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let installed = false;
	let thresholdMinutes = DEFAULT_THRESHOLD_MINUTES;
	let style: Style = "frame";
	let rotationIndex = 0;
	let generating = false;
	/** Keystrokes are the only presence signal pi hands an extension. */
	let lastKeypressAt = Date.now();
	/** One recap per absence, so a long silence does not keep re-summarizing. */
	let episodeRecapped = false;
	let awayTimer: ReturnType<typeof setTimeout> | undefined;
	let editor: CustomEditorType | undefined;

	function thresholdMs(): number {
		return thresholdMinutes * 60_000;
	}

	function hasDraft(): boolean {
		return (editor?.getText() ?? "").trim().length > 0;
	}

	async function generateRecap(ctx: ExtensionContext, since: number): Promise<RecapResult | null> {
		const digest = buildDigest(ctx, since);
		if (digest.length === 0) return null;

		const rotation = resolveRotation(ctx);
		if (rotation.length === 0) return null;

		const model = rotation[rotationIndex % rotation.length]!;
		rotationIndex = (rotationIndex + 1) % rotation.length;

		const prompt: UserMessage = {
			role: "user",
			content: `Session digest, oldest first:\n\n${capDigest(digest)}`,
			timestamp: Date.now(),
		};

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), RECAP_TIMEOUT_MS);
		try {
			const reply = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: RECAP_SYSTEM_PROMPT, messages: [prompt] },
				{ maxTokens: RECAP_MAX_TOKENS, signal: abort.signal },
			);
			const text = assistantText(reply);
			return text ? { text, modelName: model.name, stamp: formatStamp(new Date()) } : null;
		} finally {
			clearTimeout(timer);
		}
	}

	function showRecap(ctx: ExtensionContext, recap: RecapResult): void {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: TUI, theme: Theme): Component => ({
				invalidate() {},
				render(width: number): string[] {
					// Read at render time, so switching style redraws what is already up.
					return style === "frame" ? renderFrame(theme, recap, width) : renderClean(theme, recap, width);
				},
			}),
			{ placement: "aboveEditor" },
		);
	}

	/**
	 * A recap stays up until the next one replaces it, or until it is dismissed.
	 *
	 * Claude Code appends its recap to the transcript, so it scrolls up into
	 * history like any other message. pi gives extensions no way to write to the
	 * transcript — only widgets, which are pinned rather than scrolled — so
	 * clearing it when the next turn starts is the one option that loses the
	 * text outright. Better to leave it and let it be replaced.
	 */
	function clearRecap(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Resolves true when a recap was actually produced and shown. */
	async function recapNow(ctx: ExtensionContext, since: number, announce: boolean): Promise<boolean> {
		if (generating) return false;
		generating = true;
		try {
			const recap = await generateRecap(ctx, since);
			if (recap) {
				showRecap(ctx, recap);
				return true;
			}
			if (announce) ctx.ui.notify("Nothing happened worth recapping", "info");
			return false;
		} catch (error) {
			// A recap is a courtesy. A gateway that is down, unauthenticated, or
			// slow should cost the session nothing.
			if (announce) {
				ctx.ui.notify(`Recap failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			return false;
		} finally {
			generating = false;
		}
	}

	/**
	 * Arm the away check.
	 *
	 * The clock runs from the last keystroke, not from the agent's activity —
	 * a long run the user waited through is exactly when a recap is wanted. A
	 * check that lands while the agent is still working is skipped rather than
	 * queued, and `agent_settled` re-arms it.
	 */
	function scheduleAwayCheck(ctx: ExtensionContext): void {
		if (awayTimer) clearTimeout(awayTimer);
		if (!enabled) return;

		const remaining = thresholdMs() - (Date.now() - lastKeypressAt);
		const delay = Math.max(remaining, Math.min(SETTLE_GRACE_MS, thresholdMs()));

		awayTimer = setTimeout(() => {
			awayTimer = undefined;
			if (!enabled || generating || episodeRecapped) return;
			if (Date.now() - lastKeypressAt < thresholdMs()) return;
			// Still working, or never really left.
			if (!ctx.isIdle() || hasDraft()) return;

			episodeRecapped = true;
			void recapNow(ctx, lastKeypressAt, false).then((shown) => {
				// A recap that never appeared should not consume the absence: the
				// keystroke fallback gets another go at it.
				if (!shown) episodeRecapped = false;
			});
		}, delay);
		// Never hold the process open for a courtesy.
		awayTimer.unref?.();
	}

	function install(ctx: ExtensionContext): void {
		// A second install would wrap this extension's own wrapper.
		if (installed) return;
		installed = true;

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const built = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const baseHandleInput = built.handleInput.bind(built);

			built.handleInput = (data: string): void => {
				const now = Date.now();
				const idleFor = now - lastKeypressAt;
				const wasRecapped = episodeRecapped;
				lastKeypressAt = now;
				episodeRecapped = false;

				// The timer normally has the recap waiting before the user touches
				// anything. This covers the case where it could not: the agent was
				// still working when the check landed, or the call failed.
				if (enabled && !generating && !wasRecapped && idleFor >= thresholdMs() && ctx.isIdle() && !hasDraft()) {
					episodeRecapped = true;
					void recapNow(ctx, now - idleFor, false);
				}

				baseHandleInput(data);
				scheduleAwayCheck(ctx);
			};

			editor = built as CustomEditorType;
			return editor;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		install(ctx);
		scheduleAwayCheck(ctx);
	});

	// A check skipped because the agent was mid-run gets another go once it stops.
	pi.on("agent_settled", async (_event, ctx) => scheduleAwayCheck(ctx));

	pi.on("session_shutdown", async () => {
		if (awayTimer) clearTimeout(awayTimer);
		awayTimer = undefined;
	});

	pi.registerCommand("away-recap", {
		description: "Recap what happened while you were away (on|off|now|clear|style|after <minutes>|models)",
		handler: async (args, ctx) => {
			const [verb, value, ...extra] = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

			if (verb === "style") {
				if (value === undefined) {
					ctx.ui.notify(`Recap style is ${style}`, "info");
					return;
				}
				if (extra.length > 0 || !STYLES.has(value as Style)) {
					ctx.ui.notify(`Style must be one of: ${[...STYLES].join(", ")}`, "warning");
					return;
				}
				style = value as Style;
				ctx.ui.notify(`Recap style set to ${style}`, "info");
				return;
			}

			if (verb === "clear" || verb === "dismiss") {
				clearRecap(ctx);
				return;
			}

			if (verb === "now") {
				await recapNow(ctx, Date.now() - thresholdMs(), true);
				return;
			}

			if (verb === "after") {
				const minutes = Number.parseFloat(value ?? "");
				if (!Number.isFinite(minutes) || extra.length > 0) {
					ctx.ui.notify("Usage: /away-recap after <minutes>", "warning");
					return;
				}
				thresholdMinutes = clampMinutes(minutes);
				ctx.ui.notify(`Recapping after ${formatMinutes(thresholdMinutes)} away`, "info");
				return;
			}

			if (verb === "models") {
				const rotation = resolveRotation(ctx);
				if (rotation.length === 0) {
					ctx.ui.notify("No rotation model is configured and authenticated", "warning");
					return;
				}
				const next = rotation[rotationIndex % rotation.length]!.name;
				ctx.ui.notify(`Rotation: ${rotation.map((model) => model.name).join(", ")}. Next: ${next}`, "info");
				return;
			}

			if (value !== undefined || (verb !== undefined && verb !== "on" && verb !== "off")) {
				ctx.ui.notify("Usage: /away-recap [on|off|now|clear|style frame|clean|after <minutes>|models]", "warning");
				return;
			}

			const nextEnabled = verb === "off" ? false : verb === "on" ? true : !enabled;
			if (nextEnabled === enabled) {
				ctx.ui.notify(`Away recap is already ${enabled ? "on" : "off"}`, "info");
				return;
			}

			enabled = nextEnabled;
			if (!enabled) clearRecap(ctx);
			ctx.ui.notify(
				enabled ? `Away recap enabled (after ${formatMinutes(thresholdMinutes)})` : "Away recap disabled",
				"info",
			);
		},
	});
}
