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

/** Read-only view of the active session branch, including the current streamed message. */
export class ConversationPane implements Component {
	private live?: ConversationMessage;
	private revision = 0;
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
		this.invalidate();
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const leaf = this.session.getLeafId();
		if (this.cached?.width === w && this.cached.leaf === leaf && this.cached.revision === this.revision) {
			return this.cached.lines;
		}

		const lines: string[] = [];
		const contentWidth = Math.max(1, w - 2);
		const row = (text: string) => w < 3 ? " ".repeat(w) : ` ${truncateToWidth(text, contentWidth, "", true)} `;
		const messages = conversationItems(this.session.getBranch(), this.live);
		if (messages.length === 0) {
			lines.push(row(this.theme.fg("dim", "No messages yet")));
		}
		for (const message of messages) {
			lines.push(row(""));
			const label = message.role === "user" ? "User" : "Assistant";
			const color = message.role === "user" ? "accent" : "success";
			const timestamp = messageTimestamp(message.timestamp);
			const stamp = timestamp ? ` ${this.theme.fg("dim", timestamp)}` : "";
			for (const wrapped of wrapTextWithAnsi(this.theme.fg(color, this.theme.bold(label)) + stamp, contentWidth)) {
				lines.push(row(wrapped));
			}
			for (const wrapped of wrapTextWithAnsi(message.text, contentWidth)) {
				lines.push(row(wrapped));
			}
		}
		this.cached = { width: w, leaf, revision: this.revision, lines };
		return lines;
	}
}
