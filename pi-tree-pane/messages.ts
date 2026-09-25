import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type ConversationMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;
type SessionSource = Pick<ExtensionContext["sessionManager"], "getBranch" | "getLeafId">;

export interface ConversationItem {
	role: "user" | "assistant";
	text: string;
	timestamp?: number;
}

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?|\n/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

export function conversationItem(message: AgentMessage): ConversationItem | undefined {
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

export function conversationItems(entries: readonly SessionEntry[], live?: ConversationMessage): ConversationItem[] {
	const items: ConversationItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const item = conversationItem(entry.message);
		if (item) items.push(item);
	}
	// Pi emits message_end before appending the message to SessionManager. The
	// finalized message is the same object it appends, so identity avoids duplicates.
	if (live && !entries.some((entry) => entry.type === "message" && entry.message === live)) {
		const item = conversationItem(live);
		if (item) items.push(item);
	}
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
	private history?: { width: number; leaf: string | null; lines: string[]; persisted: Set<AgentMessage> };
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
			history = { width: w, leaf, lines: renderItems(conversationItems(branch), w, this.theme), persisted };
			this.history = history;
		}

		const live = this.live && !history.persisted.has(this.live) ? conversationItem(this.live) : undefined;
		const lines = live
			? history.lines.concat(renderItems([live], w, this.theme))
			: history.lines.length > 0 ? history.lines : [paneRow(this.theme.fg("dim", "No messages yet"), w)];
		this.cached = { width: w, leaf, revision: this.revision, lines };
		return lines;
	}
}
