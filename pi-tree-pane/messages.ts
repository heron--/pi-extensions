import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type ConversationMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;
type SessionSource = Pick<ExtensionContext["sessionManager"], "getBranch" | "getLeafId"> & Partial<Pick<ExtensionContext["sessionManager"], "getEntry">>;

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
	agentMessages: number;
	toolCalls: number;
	thinkingBlocks: number;
}

interface ConversationStatsState extends ConversationStats {
	leaf: string | null;
	entryCount: number;
	lastEntry?: SessionEntry;
	persisted: Set<AgentMessage>;
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

function appendedBranchEntries(
	session: SessionSource,
	entryCount: number,
	lastEntry: SessionEntry | undefined,
	leaf: string | null,
): SessionEntry[] | undefined {
	if (!session.getEntry || entryCount === 0 || !lastEntry || !leaf) return undefined;
	const reversed: SessionEntry[] = [];
	let entry = session.getEntry(leaf);
	while (entry && entry.id !== lastEntry.id) {
		reversed.push(entry);
		entry = entry.parentId ? session.getEntry(entry.parentId) : undefined;
	}
	return entry?.id === lastEntry.id ? reversed.reverse() : undefined;
}

function countMessage(message: AgentMessage, stats: ConversationStatsState): void {
	if (message.role === "user") {
		stats.userMessages++;
	} else if (message.role === "assistant") {
		stats.agentMessages++;
		for (const block of message.content) {
			if (block.type === "toolCall") stats.toolCalls++;
			else if (block.type === "thinking") stats.thinkingBlocks++;
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

function renderItems(messages: readonly ConversationItem[], width: number, theme: Theme, hasPriorMessage = false): string[] {
	const lines: string[] = [];
	const contentWidth = Math.max(1, width - 2);
	let hasMessage = hasPriorMessage;
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
		if (hasMessage) lines.push(paneRow("", width));
		hasMessage = true;
		const label = message.role === "user" ? "User" : "Agent";
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
		entryCount: number;
		lastEntry?: SessionEntry;
		lines: string[];
		hasVisibleMessage: boolean;
		persisted: Set<AgentMessage>;
		pendingActivity: ActivityCounts;
	};
	private cached?: { width: number; leaf: string | null; revision: number; lines: string[] };
	private composed?: { source: object; persistedLength: number; lines: string[] };
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
		this.composed = undefined;
		this.stats = undefined;
	}

	getStats(): ConversationStats {
		const leaf = this.session.getLeafId();
		let stats = this.stats;
		if (!stats || stats.leaf !== leaf) {
			const appended = stats
				? appendedBranchEntries(this.session, stats.entryCount, stats.lastEntry, leaf)
				: undefined;
			if (stats && appended) {
				for (const entry of appended) {
					if (entry.type !== "message") continue;
					stats.persisted.add(entry.message);
					countMessage(entry.message, stats);
				}
				stats.entryCount += appended.length;
				stats.lastEntry = appended.at(-1) ?? stats.lastEntry;
				stats.leaf = leaf;
			} else {
				const branch = this.session.getBranch();
				stats = {
					leaf,
					entryCount: branch.length,
					lastEntry: branch.at(-1),
					persisted: new Set<AgentMessage>(),
					userMessages: 0,
					agentMessages: 0,
					toolCalls: 0,
					thinkingBlocks: 0,
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
			agentMessages: result.agentMessages,
			toolCalls: result.toolCalls,
			thinkingBlocks: result.thinkingBlocks,
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
			const appended = history?.width === w
				? appendedBranchEntries(this.session, history.entryCount, history.lastEntry, leaf)
				: undefined;
			if (history && appended) {
				const appendedItems: ConversationItem[] = [];
				for (const entry of appended) {
					if (entry.type !== "message") continue;
					history.persisted.add(entry.message);
					appendConversationMessage(entry.message, appendedItems, history.pendingActivity);
				}
				if (appendedItems.length > 0) {
					history.lines.push(...renderItems(appendedItems, w, this.theme, history.hasVisibleMessage));
					if (appendedItems.some((item) => item.role !== "activity")) history.hasVisibleMessage = true;
				}
				history.entryCount += appended.length;
				history.lastEntry = appended.at(-1) ?? history.lastEntry;
				history.leaf = leaf;
			} else {
				const branch = this.session.getBranch();
				const { items, persisted, pendingActivity } = buildConversation(branch);
				history = {
					width: w,
					leaf,
					entryCount: branch.length,
					lastEntry: branch.at(-1),
					lines: renderItems(items, w, this.theme),
					hasVisibleMessage: items.some((item) => item.role !== "activity"),
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
		// Reuse one flattened output buffer so live tails never copy persisted rows.
		let composed = this.composed;
		if (!composed || composed.source !== history) {
			composed = { source: history, persistedLength: history.lines.length, lines: [...history.lines] };
			this.composed = composed;
		} else {
			composed.lines.length = composed.persistedLength;
			for (let index = composed.persistedLength; index < history.lines.length; index++) {
				composed.lines.push(history.lines[index]!);
			}
			composed.persistedLength = history.lines.length;
		}
		composed.lines.length = composed.persistedLength;
		if (tailItems.length > 0) composed.lines.push(...renderItems(tailItems, w, this.theme, history.hasVisibleMessage));
		if (composed.lines.length === 0) composed.lines.push(paneRow(this.theme.fg("dim", "No messages yet"), w));
		this.cached = { width: w, leaf, revision: this.revision, lines: composed.lines };
		return composed.lines;
	}
}
