import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type ConversationMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;
type SessionSource = Pick<ExtensionContext["sessionManager"], "getBranch" | "getLeafId">;

export interface ConversationMessageItem {
	role: "user" | "assistant";
	text: string;
	timestamp?: number;
	model?: string;
}

export interface ConversationActivityItem {
	role: "activity";
	toolCalls: number;
	thinkingBlocks: number;
}

export type ConversationItem = ConversationMessageItem | ConversationActivityItem;

export interface ConversationStats {
	userMessages: number;
	assistantMessages: number;
	totalTurns: number;
}

interface ConversationStatsState extends ConversationStats {
	leaf: string | null;
	entries: SessionEntry[];
	persisted: Set<AgentMessage>;
	awaitingAssistant: boolean;
}

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?|\n/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

function storedModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const model = safeText(value).replace(/\s+/g, " ").trim();
	return model || undefined;
}

function assistantModelId(message: Extract<AgentMessage, { role: "assistant" }>): string | undefined {
	return storedModelId(message.responseModel) ?? storedModelId(message.model);
}

export function conversationItem(message: AgentMessage): ConversationMessageItem | undefined {
	if (message.role === "user") {
		const content = typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content;
		const text = safeText(content.map((block) => block.type === "text" ? block.text : "[image]").join("\n"));
		return { role: "user", text: text.trim() ? text : "[empty message]", timestamp: message.timestamp };
	}
	if (message.role === "assistant") {
		const text = safeText(message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n"));
		// A tool-only or thinking-only assistant turn has no message to list.
		const model = assistantModelId(message);
		return text.trim()
			? { role: "assistant", text, timestamp: message.timestamp, ...(model ? { model } : {}) }
			: undefined;
	}
	return undefined;
}

function appendActivity(items: ConversationItem[], activity: Omit<ConversationActivityItem, "role">): void {
	if (activity.toolCalls === 0 && activity.thinkingBlocks === 0) return;
	items.push({ role: "activity", toolCalls: activity.toolCalls, thinkingBlocks: activity.thinkingBlocks });
	activity.toolCalls = 0;
	activity.thinkingBlocks = 0;
}

function appendAssistantMessage(
	message: Extract<AgentMessage, { role: "assistant" }>,
	items: ConversationItem[],
	pendingActivity: Omit<ConversationActivityItem, "role">,
): void {
	let textBlocks: string[] = [];
	const model = assistantModelId(message);
	const appendText = () => {
		if (textBlocks.length === 0) return;
		const text = safeText(textBlocks.join("\n"));
		textBlocks = [];
		if (!text.trim()) return;
		appendActivity(items, pendingActivity);
		items.push({ role: "assistant", text, timestamp: message.timestamp, ...(model ? { model } : {}) });
	};

	for (const block of message.content) {
		if (block.type === "text") {
			textBlocks.push(block.text);
		} else if (block.type === "thinking") {
			appendText();
			pendingActivity.thinkingBlocks++;
		} else if (block.type === "toolCall") {
			appendText();
			pendingActivity.toolCalls++;
		}
	}
	appendText();
}

type ActivityCounts = Omit<ConversationActivityItem, "role">;

function appendConversationMessage(message: AgentMessage, items: ConversationItem[], pendingActivity: ActivityCounts): void {
	if (message.role === "assistant") {
		appendAssistantMessage(message, items, pendingActivity);
		return;
	}
	const item = conversationItem(message);
	if (!item) return;
	appendActivity(items, pendingActivity);
	items.push(item);
}

function buildConversation(entries: readonly SessionEntry[]): {
	items: ConversationItem[];
	persisted: Set<AgentMessage>;
	pendingActivity: ActivityCounts;
} {
	const items: ConversationItem[] = [];
	const persisted = new Set<AgentMessage>();
	const pendingActivity = { toolCalls: 0, thinkingBlocks: 0 };
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		persisted.add(entry.message);
		appendConversationMessage(entry.message, items, pendingActivity);
	}
	return { items, persisted, pendingActivity };
}

export function conversationItems(entries: readonly SessionEntry[], live?: ConversationMessage): ConversationItem[] {
	const { items, persisted, pendingActivity } = buildConversation(entries);
	// Pi emits message_end before appending the message to SessionManager. The
	// finalized message is the same object it appends, so identity avoids duplicates.
	if (live && !persisted.has(live)) appendConversationMessage(live, items, pendingActivity);
	appendActivity(items, pendingActivity);
	return items;
}

function assistantReturnsControl(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
	return message.stopReason !== "pending"
		&& message.stopReason !== "deferred"
		&& !message.content.some((block) => block.type === "toolCall");
}

function countMessage(message: AgentMessage, stats: ConversationStatsState): void {
	if (message.role === "user") {
		stats.userMessages++;
		stats.awaitingAssistant = true;
	} else if (message.role === "assistant") {
		stats.assistantMessages++;
		if (stats.awaitingAssistant && assistantReturnsControl(message)) {
			stats.totalTurns++;
			stats.awaitingAssistant = false;
		}
	}
}

function messageTimestamp(timestamp: number | undefined): string | undefined {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return undefined;
	const day = [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return `${day} ${time}`;
}

function paneRow(text: string, width: number): string {
	return width < 3 ? " ".repeat(width) : ` ${truncateToWidth(text, width - 2, "", true)} `;
}

function renderItems(messages: readonly ConversationItem[], width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const contentWidth = Math.max(1, width - 2);
	for (const message of messages) {
		if (message.role === "activity") {
			const toolCalls = `${message.toolCalls} tool call${message.toolCalls === 1 ? "" : "s"}`;
			const thinkingBlocks = `${message.thinkingBlocks} thinking block${message.thinkingBlocks === 1 ? "" : "s"}`;
			const summary = theme.fg("dim", theme.italic(`${toolCalls}, ${thinkingBlocks}`));
			for (const wrapped of wrapTextWithAnsi(summary, contentWidth)) {
				lines.push(paneRow(wrapped, width));
			}
			continue;
		}

		lines.push(paneRow("", width));
		const label = message.role === "user" ? "User" : "Assistant";
		const color = message.role === "user" ? "syntaxType" : "success";
		const timestamp = messageTimestamp(message.timestamp);
		const model = message.role === "assistant" && message.model ? ` ${theme.fg(color, `(${message.model})`)}` : "";
		const stamp = timestamp ? ` ${theme.fg("dim", timestamp)}` : "";
		for (const wrapped of wrapTextWithAnsi(theme.fg(color, theme.bold(label)) + model + stamp, contentWidth)) {
			lines.push(paneRow(wrapped, width));
		}
		for (const wrapped of wrapTextWithAnsi(message.text, contentWidth)) {
			lines.push(paneRow(wrapped, width));
		}
	}
	return lines;
}

/** Read-only view of the active session branch, including the current streamed message. */
export class ConversationPane implements Component {
	private live?: ConversationMessage;
	private revision = 0;
	private history?: {
		width: number;
		leaf: string | null;
		entries: SessionEntry[];
		lines: string[];
		persisted: Set<AgentMessage>;
		pendingActivity: ActivityCounts;
	};
	private cached?: { width: number; leaf: string | null; revision: number; lines: string[] };
	private stats?: ConversationStatsState;
	private readonly session: SessionSource;
	private readonly theme: Theme;

	constructor(session: SessionSource, theme: Theme) {
		this.session = session;
		this.theme = theme;
	}

	setLive(message?: ConversationMessage): void {
		this.live = message;
		this.revision++;
	}

	invalidate(): void {
		this.history = undefined;
		this.cached = undefined;
		this.stats = undefined;
	}

	getStats(): ConversationStats {
		const leaf = this.session.getLeafId();
		let stats = this.stats;
		if (!stats || stats.leaf !== leaf) {
			const branch = this.session.getBranch();
			const statsLength = stats?.entries.length ?? 0;
			const extendsStats = branch.length >= statsLength
				&& (statsLength === 0 || branch[statsLength - 1] === stats?.entries[statsLength - 1]);
			if (stats && extendsStats) {
				for (let index = stats.entries.length; index < branch.length; index++) {
					const entry = branch[index]!;
					if (entry.type !== "message") continue;
					stats.persisted.add(entry.message);
					countMessage(entry.message, stats);
				}
				stats.entries = branch.slice();
				stats.leaf = leaf;
			} else {
				stats = {
					leaf,
					entries: branch.slice(),
					persisted: new Set<AgentMessage>(),
					userMessages: 0,
					assistantMessages: 0,
					totalTurns: 0,
					awaitingAssistant: false,
				};
				for (const entry of branch) {
					if (entry.type !== "message") continue;
					stats.persisted.add(entry.message);
					countMessage(entry.message, stats);
				}
				this.stats = stats;
			}
		}

		const result = this.live && !stats.persisted.has(this.live) ? { ...stats } : stats;
		if (result !== stats) countMessage(this.live!, result);
		return {
			userMessages: result.userMessages,
			assistantMessages: result.assistantMessages,
			totalTurns: result.totalTurns,
		};
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const leaf = this.session.getLeafId();
		if (this.cached?.width === w && this.cached.leaf === leaf && this.cached.revision === this.revision) {
			return this.cached.lines;
		}

		let history = this.history;
		if (!history || history.width !== w || history.leaf !== leaf) {
			const branch = this.session.getBranch();
			const historyLength = history?.entries.length ?? 0;
			// Session entries have one immutable parent, so the same entry at the
			// previous leaf depth proves the complete path prefix is unchanged.
			const extendsHistory = history?.width === w
				&& branch.length >= historyLength
				&& (historyLength === 0 || branch[historyLength - 1] === history.entries[historyLength - 1]);
			if (history && extendsHistory) {
				const appendedItems: ConversationItem[] = [];
				for (let index = history.entries.length; index < branch.length; index++) {
					const entry = branch[index]!;
					if (entry.type !== "message") continue;
					history.persisted.add(entry.message);
					appendConversationMessage(entry.message, appendedItems, history.pendingActivity);
				}
				if (appendedItems.length > 0) history.lines.push(...renderItems(appendedItems, w, this.theme));
				history.entries = branch.slice();
				history.leaf = leaf;
			} else {
				const { items, persisted, pendingActivity } = buildConversation(branch);
				history = {
					width: w,
					leaf,
					entries: branch.slice(),
					lines: renderItems(items, w, this.theme),
					persisted,
					pendingActivity,
				};
				this.history = history;
			}
		}

		const tailItems: ConversationItem[] = [];
		const pendingActivity = { ...history.pendingActivity };
		if (this.live && !history.persisted.has(this.live)) {
			appendConversationMessage(this.live, tailItems, pendingActivity);
		}
		appendActivity(tailItems, pendingActivity);
		const lines = history.lines.slice();
		if (tailItems.length > 0) lines.push(...renderItems(tailItems, w, this.theme));
		if (lines.length === 0) lines.push(paneRow(this.theme.fg("dim", "No messages yet"), w));
		this.cached = { width: w, leaf, revision: this.revision, lines };
		return lines;
	}
}
