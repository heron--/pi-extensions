/**
 * thinking-labels extension
 *
 * Labels thinking blocks in the transcript — `Thinking: …` — painted with
 * the shared thinking-level scheme (lib/thinking-colors.ts), so the
 * transcript label, the context-footer badge, and the model picker's level
 * rows all speak the same colors. The level painted is the session's level
 * at label time; when no level applies (unknown, or "off"), the label falls
 * back to the theme's accent.
 *
 * The label is PRESENTATION ONLY. It is baked into the stored thinking text
 * so it survives reloads — and the `context` handler strips it (plus every
 * ANSI code it carried) from assistant thinking blocks before each LLM
 * call, so it never reaches the model and never accumulates turn over turn.
 *
 * Events, not patches: `message_update` labels the transient streaming
 * payload, `message_end` labels the persisted final message, `context`
 * sanitizes. API-aware: only the transports that emit thinking blocks are
 * labelled (the OpenAI reasoning APIs and the anthropic family); other
 * openai-* transports are deliberately excluded so the formatter is not
 * applied to transports that never carry thinking.
 *
 * Replacement for pi-tool-display's always-on thinking labeling (part 02 of
 * retiring it). Until it is retired both extensions run, and the artifact
 * stripper makes the double pass idempotent: whichever runs last strips the
 * other's label and lays down one of ours.
 *
 * Toggle: `/thinking-labels [on|off]` (persisted in the agent config dir).
 */

import type { AssistantMessage, ModelThinkingLevel, ThinkingContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paintThinkingLevel } from "../lib/thinking-colors.ts";

const THINKING_LABEL = "Thinking:";
/** Matches this extension's label AND upstream's — the stripper is the compat layer. */
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
/** Bare SGR fragments (`;38;2;...m`) exposed when colored spans split across content. */
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;
/** Content walk guards: unusual payloads are left alone, not exploded. */
const MAX_CONTENT_DEPTH = 16;

const OPENAI_REASONING_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
]);

function normalizeApiName(api: unknown): string | undefined {
	if (typeof api !== "string") return undefined;
	const normalized = api.trim().toLowerCase();
	return normalized.length > 0 ? normalized : undefined;
}

/**
 * Only the transports that emit thinking blocks are labelled: the OpenAI
 * reasoning APIs and the anthropic family explicitly; other openai-* transports
 * are deliberately excluded so the formatter is not applied to transports that
 * never carry thinking. Unknown APIs default to labelling when thinking blocks
 * exist.
 */
function shouldLabelThinkingForApi(api: unknown): boolean {
	const normalizedApi = normalizeApiName(api);
	if (!normalizedApi) return true;
	if (OPENAI_REASONING_APIS.has(normalizedApi)) return true;
	if (normalizedApi.startsWith("anthropic-")) return true;
	if (normalizedApi.startsWith("openai-")) return false;
	return true;
}

/* -------------------------------------------------------------------------- */
/* Presentation artifacts                                                      */
/* -------------------------------------------------------------------------- */

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripLeadingAnsiFragments(text: string): string {
	let current = text;
	while (true) {
		const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
		if (next === current) return current;
		current = next;
	}
}

/**
 * Reduce a labelled thinking text back to bare content: strip ANSI, then the
 * label prefix, then any leading fragments the label's removal exposed — in a
 * loop, because a colored label can hide a second one. This is what makes
 * re-labelling idempotent and what keeps the model's context clean.
 */
function stripThinkingPresentationArtifacts(text: string): string {
	let current = stripAnsi(text);
	let removedThinkingLabel = false;

	while (true) {
		const withoutLabel = current.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart();
		if (withoutLabel !== current) {
			current = withoutLabel;
			removedThinkingLabel = true;
			continue;
		}

		const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
		if (withoutAnsiFragments !== current) {
			const fragmentExposedAnotherLabel =
				withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
				withoutAnsiFragments;
			if (removedThinkingLabel || fragmentExposedAnotherLabel) {
				current = withoutAnsiFragments;
				continue;
			}
		}

		return current;
	}
}

/* -------------------------------------------------------------------------- */
/* Content walking                                                             */
/* -------------------------------------------------------------------------- */

function isThinkingBlock(value: unknown): value is ThinkingContent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.type === "thinking" && typeof record.thinking === "string";
}

/**
 * Map every thinking block's text — walking nested arrays defensively, with
 * depth and cycle guards, leaving everything else untouched — and report
 * whether anything changed so callers can avoid needless copies.
 */
function mapThinkingContent(
	content: unknown[],
	mapThinkingText: (text: string) => string,
	depth = 0,
	seen: WeakSet<object> = new WeakSet(),
): { content: unknown[]; changed: boolean } {
	if (depth > MAX_CONTENT_DEPTH || seen.has(content)) return { content, changed: false };

	seen.add(content);
	let changed = false;
	const nextContent = content.map((block) => {
		if (Array.isArray(block)) {
			const nested = mapThinkingContent(block, mapThinkingText, depth + 1, seen);
			if (nested.changed) {
				changed = true;
				return nested.content;
			}
			return block;
		}

		if (!isThinkingBlock(block)) return block;

		const nextThinking = mapThinkingText(block.thinking);
		if (nextThinking === block.thinking) return block;

		changed = true;
		return { ...block, thinking: nextThinking };
	});

	return { content: changed ? nextContent : content, changed };
}

/* -------------------------------------------------------------------------- */
/* Labelling and sanitizing                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The label and its colors: the level that produced the turn paints through
 * the shared scheme (static — baked text never animates), and the accent is
 * the fallback when no level applies. The body keeps pi's thinkingText tone.
 */
function formatLabeledThinking(
	theme: Theme,
	level: ModelThinkingLevel | undefined,
	thinkingText: string,
): string {
	const label =
		level && level !== "off"
			? paintThinkingLevel(theme, level, THINKING_LABEL, false)
			: theme.fg("accent", THINKING_LABEL);
	return `${label} ${theme.fg("thinkingText", thinkingText)}`;
}

function labelThinkingBlocks(message: AssistantMessage, theme: Theme, level: ModelThinkingLevel | undefined): void {
	const content = message.content as unknown;
	if (!Array.isArray(content)) return;
	const mapped = mapThinkingContent(content, (thinking) => {
		const bare = stripThinkingPresentationArtifacts(thinking).trim();
		return bare ? formatLabeledThinking(theme, level, bare) : thinking;
	});
	if (mapped.changed) message.content = mapped.content as AssistantMessage["content"];
}

/** Strip presentation artifacts from every assistant thinking block, in place. */
function sanitizeContextMessages(messages: AgentMessage[]): void {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "assistant") return message;
		const content = (message as AssistantMessage).content as unknown;
		if (!Array.isArray(content)) return message;
		const mapped = mapThinkingContent(content, (thinking) => {
			const bare = stripThinkingPresentationArtifacts(thinking).trim();
			return bare ? bare : thinking;
		});
		if (!mapped.changed) return message;
		changed = true;
		return { ...message, content: mapped.content } as AssistantMessage;
	});
	if (changed) messages.splice(0, messages.length, ...next);
}

/* -------------------------------------------------------------------------- */
/* Preference                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The persisted toggle, in the agent config directory — NOT under
 * `<agent dir>/extensions/`, which resolves into this repo through the install
 * symlinks (the same reasoning as ../lib/thinking-colors.ts documents).
 */
function configFile(): string {
	return join(getAgentDir(), "pi-thinking-labels", "config.json");
}

interface StoredConfig {
	enabled?: boolean;
}

function loadEnabledPreference(): boolean {
	try {
		const stored = JSON.parse(readFileSync(configFile(), "utf8")) as StoredConfig;
		if (typeof stored.enabled === "boolean") return stored.enabled;
	} catch {
		// No config yet, or unreadable: default on.
	}
	return true;
}

function saveEnabledPreference(value: boolean): boolean {
	try {
		const file = configFile();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ enabled: value }, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/* Extension entry                                                             */
/* -------------------------------------------------------------------------- */

const registeredApis = new WeakSet<ExtensionAPI>();
let enabled = true;

export default function thinkingLabelsExtension(pi: ExtensionAPI): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const label = (event: { message: AgentMessage }, ctx: ExtensionContext | undefined): void => {
		if (!enabled) return;
		const message = event.message;
		if (message.role !== "assistant" || !shouldLabelThinkingForApi((message as { api?: unknown }).api)) return;
		const theme = ctx?.ui?.theme;
		if (!theme) return;
		try {
			labelThinkingBlocks(message, theme, ctx?.thinkingLevel);
		} catch (error) {
			ctx?.ui?.notify(
				`thinking label failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	};

	pi.on("message_update", (event, ctx) => label(event, ctx));
	// message_end's labelling is persisted: the label survives reloads, and the
	// context handler below is what keeps it out of the model's context.
	pi.on("message_end", (event, ctx) => label(event, ctx));

	pi.on("context", (event, ctx) => {
		if (!enabled) return;
		try {
			sanitizeContextMessages(event.messages);
		} catch (error) {
			ctx?.ui?.notify(
				`thinking label sanitization failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.on("session_start", () => {
		enabled = loadEnabledPreference();
	});

	pi.on("session_shutdown", () => {
		registeredApis.delete(pi);
	});

	pi.registerCommand("thinking-labels", {
		description: "Toggle the Thinking: labels on thinking blocks",
		handler: async (args, ctx) => {
			const verb = (args ?? "").trim().toLowerCase();
			if (verb !== "" && verb !== "on" && verb !== "off") {
				ctx.ui.notify("Usage: /thinking-labels [on|off]", "warning");
				return;
			}
			if (verb !== "") enabled = verb === "on";
			ctx.ui.notify(
				verb === ""
					? `Thinking labels are ${enabled ? "on" : "off"}`
					: saveEnabledPreference(enabled)
						? `Thinking labels ${enabled ? "enabled" : "disabled"}`
						: `Thinking labels ${enabled ? "enabled" : "disabled"} for this session only (config file not writable)`,
				"info",
			);
		},
	});
}
