import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type ConversationMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;
type SessionSource = Pick<ExtensionContext["sessionManager"], "getBranch" | "getLeafId">;

export interface ConversationMessageItem {
	role: "user" | "assistant";
	text: string;
	timestamp?: number;
}

export interface ConversationActivityItem {
	role: "activity";
	toolCalls: number;
	thinkingBlocks: number;
}

export type ConversationItem = ConversationMessageItem | ConversationActivityItem;

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?|\n/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
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
		return text.trim() ? { role: "assistant", text, timestamp: message.timestamp } : undefined;
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
	const appendText = () => {
		if (textBlocks.length === 0) return;
		const text = safeText(textBlocks.join("\n"));
		textBlocks = [];
		if (!text.trim()) return;
		appendActivity(items, pendingActivity);
		items.push({ role: "assistant", text, timestamp: message.timestamp });
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

export function conversationItems(entries: readonly SessionEntry[], live?: ConversationMessage): ConversationItem[] {
	const items: ConversationItem[] = [];
	const persisted = new Set<AgentMessage>();
	const pendingActivity = { toolCalls: 0, thinkingBlocks: 0 };
	const appendMessage = (message: AgentMessage) => {
		if (message.role === "assistant") {
			appendAssistantMessage(message, items, pendingActivity);
			return;
		}
		const item = conversationItem(message);
		if (!item) return;
		appendActivity(items, pendingActivity);
		items.push(item);
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		persisted.add(entry.message);
		appendMessage(entry.message);
	}
	// Pi emits message_end before appending the message to SessionManager. The
	// finalized message is the same object it appends, so identity avoids duplicates.
	if (live && !persisted.has(live)) appendMessage(live);
	appendActivity(items, pendingActivity);
	return items;
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
		const color = message.role === "user" ? "accent" : "success";
		const timestamp = messageTimestamp(message.timestamp);
		const stamp = timestamp ? ` ${theme.fg("dim", timestamp)}` : "";
		for (const wrapped of wrapTextWithAnsi(theme.fg(color, theme.bold(label)) + stamp, contentWidth)) {
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
		lines: string[];
		persisted: Set<AgentMessage>;
		pendingActivity?: ConversationActivityItem;
	};
	private cached?: { width: number; leaf: string | null; revision: number; lines: string[] };
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
			const persisted = new Set<AgentMessage>();
			for (const entry of branch) {
				if (entry.type === "message") persisted.add(entry.message);
			}
			const items = conversationItems(branch);
			const last = items.at(-1);
			let pendingActivity: ConversationActivityItem | undefined;
			if (last?.role === "activity") {
				pendingActivity = last;
				items.pop();
			}
			history = { width: w, leaf, lines: renderItems(items, w, this.theme), persisted, pendingActivity };
			this.history = history;
		}

		const live = this.live && !history.persisted.has(this.live) ? this.live : undefined;
		const liveItems = live ? conversationItems([], live) : [];
		const activity = {
			role: "activity" as const,
			toolCalls: history.pendingActivity?.toolCalls ?? 0,
			thinkingBlocks: history.pendingActivity?.thinkingBlocks ?? 0,
		};
		while (true) {
			const leading = liveItems[0];
			if (!leading || leading.role !== "activity") break;
			liveItems.shift();
			activity.toolCalls += leading.toolCalls;
			activity.thinkingBlocks += leading.thinkingBlocks;
		}
		const lines = history.lines.slice();
		if (activity.toolCalls > 0 || activity.thinkingBlocks > 0) {
			lines.push(...renderItems([activity], w, this.theme));
		}
		if (liveItems.length > 0) lines.push(...renderItems(liveItems, w, this.theme));
		if (lines.length === 0) lines.push(paneRow(this.theme.fg("dim", "No messages yet"), w));
		this.cached = { width: w, leaf, revision: this.revision, lines };
		return lines;
	}
}
