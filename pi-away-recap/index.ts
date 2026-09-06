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
const ICON = "";

const DEFAULT_THRESHOLD_MINUTES = 5;
const MIN_THRESHOLD_MINUTES = 0.05;
const MAX_THRESHOLD_MINUTES = 240;

/** A recap is a couple of lines, so the reply does not need much room. */
const RECAP_MAX_TOKENS = 400;
const RECAP_TIMEOUT_MS = 30_000;
/** Digest budget. The tail is kept, because the newest activity matters most. */
const DIGEST_MAX_CHARS = 6_000;
const ENTRY_TEXT_MAX_CHARS = 400;

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
	"You are given a digest of what happened in their coding session while they were gone.",
	"Tell them what happened, in at most three short sentences, plainest possible language.",
	"Lead with the outcome — what now exists, what broke, what is waiting on them.",
	"",
	"Write only the recap itself. No preamble, no greeting, no sign-off, no bullet points,",
	"no markdown headings, no restating that they were away. Never invent activity that is",
	"not in the digest. If the digest shows very little, say so in one short sentence.",
].join("\n");

interface RecapResult {
	text: string;
	modelName: string;
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
 * Plain-text account of the session entries added while the user was away.
 *
 * Deliberately not the raw transcript: tool arguments and results are the bulk
 * of a session and almost none of what a recap needs, so each entry collapses
 * to one line naming what happened.
 */
function buildDigest(ctx: ExtensionContext, since: number): string[] {
	const lines: string[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (Date.parse(entry.timestamp) < since) continue;

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
			if (said.trim()) lines.push(`[agent] ${collapse(said, ENTRY_TEXT_MAX_CHARS)}`);

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
			if (said.trim()) lines.push(`[user] ${collapse(said, ENTRY_TEXT_MAX_CHARS)}`);
		}
	}

	return lines;
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

export default function awayRecapExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let installed = false;
	let thresholdMinutes = DEFAULT_THRESHOLD_MINUTES;
	let rotationIndex = 0;
	let generating = false;
	/** Keystrokes are the only presence signal pi hands an extension. */
	let lastKeypressAt = Date.now();

	function thresholdMs(): number {
		return thresholdMinutes * 60_000;
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
			return text ? { text, modelName: model.name } : null;
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
					const inner = Math.max(1, width - 2);
					const rows = wrap(recap.text, inner).map((row) => `${theme.fg("dim", ICON)} ${row}`);
					rows.push(theme.italic(theme.fg("dim", `  generated by ${recap.modelName}`)));
					return rows;
				},
			}),
			{ placement: "aboveEditor" },
		);
	}

	function clearRecap(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	async function recapNow(ctx: ExtensionContext, since: number, announce: boolean): Promise<void> {
		if (generating) return;
		generating = true;
		try {
			const recap = await generateRecap(ctx, since);
			if (recap) {
				showRecap(ctx, recap);
			} else if (announce) {
				ctx.ui.notify("Nothing happened worth recapping", "info");
			}
		} catch (error) {
			// A recap is a courtesy. A gateway that is down, unauthenticated, or
			// slow should cost the session nothing.
			if (announce) {
				ctx.ui.notify(`Recap failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			generating = false;
		}
	}

	function install(ctx: ExtensionContext): void {
		// A second install would wrap this extension's own wrapper.
		if (installed) return;
		installed = true;

		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = previousFactory
				? previousFactory(tui, editorTheme, keybindings)
				: new CustomEditor(tui, editorTheme, keybindings);
			const baseHandleInput = editor.handleInput.bind(editor);

			editor.handleInput = (data: string): void => {
				const now = Date.now();
				const idleFor = now - lastKeypressAt;
				lastKeypressAt = now;

				// The first keystroke after a long silence is the user sitting back
				// down. A draft already in the box means they never really left.
				if (enabled && !generating && idleFor >= thresholdMs() && ctx.isIdle() && !editor.getText().trim()) {
					void recapNow(ctx, now - idleFor, false);
				}

				baseHandleInput(data);
			};

			return editor as CustomEditorType;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	// The recap describes the gap the user just crossed, so it stops being true
	// the moment they act on it.
	pi.on("input", async (_event, ctx) => clearRecap(ctx));
	pi.on("turn_start", async (_event, ctx) => clearRecap(ctx));

	pi.registerCommand("away-recap", {
		description: "Recap what happened while you were away (on|off|now|after <minutes>|models)",
		handler: async (args, ctx) => {
			const [verb, value, ...extra] = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

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
				ctx.ui.notify("Usage: /away-recap [on|off|now|after <minutes>|models]", "warning");
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
