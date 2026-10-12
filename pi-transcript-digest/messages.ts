import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

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
	elapsedMs?: number;
}

export interface ConversationAgentStartItem {
	role: "agent-start";
	timestamp?: number;
	model?: string;
}

export interface ConversationAgentEndItem extends Pick<ConversationActivityItem, "toolCalls" | "thinkingBlocks"> {
	role: "agent-end";
	agentMs?: number;
	userMs?: number;
}

export interface ConversationQuestion {
	header?: string;
	question: string;
	options: string[];
	multiSelect: boolean;
}

/** Questions the agent put to the user with `ask_user_question`. */
export interface ConversationQuestionsItem {
	role: "questions";
	questions: ConversationQuestion[];
}

export interface ConversationAnswer {
	/** The question's header chip, or its text when it has none. */
	label: string;
	answer?: string;
	notes?: string;
}

/** The user's reply to `ask_user_question`, shown as its own User section. */
export interface ConversationAnswersItem {
	role: "answers";
	answers: ConversationAnswer[];
	declined: boolean;
	note?: string;
	timestamp?: number;
}

export interface ConversationNoticeItem {
	role: "notice";
	text: string;
}

export type ConversationItem =
	| ConversationMessageItem
	| ConversationActivityItem
	| ConversationAgentStartItem
	| ConversationAgentEndItem
	| ConversationQuestionsItem
	| ConversationAnswersItem
	| ConversationNoticeItem;

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

const QUESTION_TOOL = "ask_user_question";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: unknown): string | undefined {
	return typeof value === "string" ? safeText(value).replace(/\s+/g, " ").trim() || undefined : undefined;
}

function multiLine(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? safeText(value).trim() : undefined;
}

/** Streaming and third-party arguments may be partial, so invalid entries are skipped. */
function askedQuestions(args: unknown): ConversationQuestion[] {
	const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : [];
	return questions.flatMap((value): ConversationQuestion[] => {
		if (!isRecord(value)) return [];
		const question = multiLine(value.question);
		if (!question) return [];
		const header = oneLine(value.header);
		const options = Array.isArray(value.options)
			? value.options.flatMap((option) => {
				const label = isRecord(option) ? oneLine(option.label) : undefined;
				return label ? [label] : [];
			})
			: [];
		return [{ ...(header ? { header } : {}), question, options, multiSelect: value.multiSelect === true }];
	});
}

function answerText(answer: Record<string, unknown>): string | undefined {
	if (answer.kind === "multi") {
		const selected = Array.isArray(answer.selected) ? answer.selected.flatMap((label) => oneLine(label) ?? []) : [];
		return selected.length ? selected.join(", ") : undefined;
	}
	return multiLine(answer.answer);
}

/**
 * Reads the questionnaire result from the tool's `details`. A result without
 * them, or one reporting an error, means the user never saw the questions.
 */
function questionAnswers(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	asked: readonly ConversationQuestion[] | undefined,
): Omit<ConversationAnswersItem, "timestamp"> | undefined {
	const details: unknown = message.details;
	if (message.isError || !isRecord(details) || details.error !== undefined) return undefined;
	if (!Array.isArray(details.answers) || typeof details.cancelled !== "boolean") return undefined;
	const note = multiLine(details.globalNote);
	const replies = details.answers.filter(isRecord);
	const label = (index: number, fallback: unknown) =>
		asked?.[index]?.header ?? oneLine(asked?.[index]?.question) ?? oneLine(fallback) ?? `Question ${index + 1}`;
	const answer = (reply: Record<string, unknown> | undefined, index: number): ConversationAnswer => {
		const text = reply ? answerText(reply) : undefined;
		const notes = multiLine(reply?.notes);
		return { label: label(index, reply?.question), ...(text ? { answer: text } : {}), ...(notes ? { notes } : {}) };
	};
	const answers = details.cancelled
		? []
		: asked?.length
			? asked.map((_question, index) => answer(replies.find((reply) => reply.questionIndex === index), index))
			: replies.map((reply, index) => answer(reply, typeof reply.questionIndex === "number" ? reply.questionIndex : index));
	return { role: "answers", answers, declined: details.cancelled || (answers.every((item) => !item.answer) && !note), ...(note ? { note } : {}) };
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

function appendActivity(items: ConversationItem[], activity: PendingState, end: number | undefined): void {
	if (activity.toolCalls === 0 && activity.thinkingBlocks === 0) return;
	const duration = elapsedMs(activity.activitySince, end);
	items.push({
		role: "activity", toolCalls: activity.toolCalls, thinkingBlocks: activity.thinkingBlocks,
		...(duration !== undefined ? { elapsedMs: duration } : {}),
	});
	activity.toolCalls = 0;
	activity.thinkingBlocks = 0;
}

/**
 * Walks an assistant message the way the digest shows it: runs of text become
 * one visible entry each, split by the thinking blocks and tool calls between.
 * Rendering and the header counts both use this, so they cannot disagree.
 */
function forEachAssistantPart(
	message: Extract<AgentMessage, { role: "assistant" }>,
	onText: (text: string) => void,
	onActivity: (type: "thinking" | "toolCall") => void,
	onQuestions: (id: string, questions: ConversationQuestion[]) => void,
): void {
	let textBlocks: string[] = [];
	const flush = () => {
		if (textBlocks.length === 0) return;
		const text = safeText(textBlocks.join("\n"));
		textBlocks = [];
		if (text.trim()) onText(text);
	};
	for (const block of message.content) {
		if (block.type === "text") {
			textBlocks.push(block.text);
		} else if (block.type === "toolCall" && block.name === QUESTION_TOOL) {
			flush();
			onQuestions(block.id, askedQuestions(block.arguments));
		} else if (block.type === "thinking" || block.type === "toolCall") {
			flush();
			onActivity(block.type);
		}
	}
	flush();
}

function appendAssistantMessage(
	message: Extract<AgentMessage, { role: "assistant" }>,
	items: ConversationItem[],
	pendingActivity: PendingState,
): void {
	const model = assistantModelId(message);
	if (!pendingActivity.sectionOpen) {
		items.push({ role: "agent-start", timestamp: message.timestamp, ...(model ? { model } : {}) });
		pendingActivity.sectionOpen = true;
		pendingActivity.totalToolCalls = 0;
		pendingActivity.totalThinkingBlocks = 0;
		pendingActivity.turnStart ??= validTime(message.timestamp);
		pendingActivity.activitySince = validTime(message.timestamp);
	}
	forEachAssistantPart(message, (text) => {
		const timestamp = validTime(message.timestamp);
		appendActivity(items, pendingActivity, timestamp);
		items.push({ role: "assistant", text, timestamp: message.timestamp, ...(model ? { model } : {}) });
		pendingActivity.activitySince = timestamp;
	}, (type) => {
		if (type === "thinking") {
			pendingActivity.thinkingBlocks++;
			pendingActivity.totalThinkingBlocks++;
		} else {
			pendingActivity.toolCalls++;
			pendingActivity.totalToolCalls++;
		}
	}, (id, questions) => {
		// The questions are shown rather than summarized, so they count toward
		// the section's tool calls but not the activity between visible entries.
		const timestamp = validTime(message.timestamp);
		appendActivity(items, pendingActivity, timestamp);
		pendingActivity.totalToolCalls++;
		pendingActivity.questions.set(id, questions);
		if (questions.length > 0) items.push({ role: "questions", questions });
		pendingActivity.activitySince = timestamp;
	});
}

interface PendingState extends Pick<ConversationActivityItem, "toolCalls" | "thinkingBlocks"> {
	/** The previous visible agent message's timestamp, or the section's first timestamp. */
	activitySince?: number;
	sectionOpen: boolean;
	totalToolCalls: number;
	totalThinkingBlocks: number;
	/** When Pi picked up the user interaction that started the section. */
	turnStart?: number;
	/** When the latest assistant message or tool result in the section was persisted. */
	agentEnd?: number;
	/** The latest agent message returned control to the user rather than waiting on tools. */
	handedBack?: boolean;
	/** Unanswered `ask_user_question` calls by tool call id. */
	questions: Map<string, ConversationQuestion[]>;
}

function pendingState(): PendingState {
	return { toolCalls: 0, thinkingBlocks: 0, sectionOpen: false, totalToolCalls: 0, totalThinkingBlocks: 0, questions: new Map() };
}

// Sub-second differences are timestamp noise rather than a useful displayed duration.
const MIN_ELAPSED_MS = 1000;

function validTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Session entries are stamped when Pi persists them, i.e. once the message is complete. */
function entryTime(entry: SessionEntry): number | undefined {
	return validTime(Date.parse(entry.timestamp));
}

function elapsedMs(start?: number, end?: number): number | undefined {
	return start !== undefined && end !== undefined && end - start >= MIN_ELAPSED_MS ? end - start : undefined;
}

function closeAgentSection(items: ConversationItem[], pending: PendingState, user?: { receivedAt?: number; sentAt?: number }): void {
	const end = user && !pending.handedBack ? user.receivedAt ?? pending.agentEnd : pending.agentEnd;
	appendActivity(items, pending, end);
	if (!pending.sectionOpen) return;
	const agentMs = elapsedMs(pending.turnStart, end);
	// A message queued before the agent finished has no waiting time of its own.
	const userMs = user && pending.handedBack ? elapsedMs(pending.agentEnd, user.sentAt) : undefined;
	items.push({
		role: "agent-end", toolCalls: pending.totalToolCalls, thinkingBlocks: pending.totalThinkingBlocks,
		...(agentMs !== undefined ? { agentMs } : {}),
		...(userMs !== undefined ? { userMs } : {}),
	});
	pending.sectionOpen = false;
}

/** Answers end the agent section like a user message; the agent was waiting on them. */
function appendAnswers(answers: Omit<ConversationAnswersItem, "timestamp">, items: ConversationItem[], pending: PendingState, answeredAt?: number): void {
	pending.handedBack = true;
	closeAgentSection(items, pending, { receivedAt: answeredAt, sentAt: answeredAt });
	pending.turnStart = answeredAt;
	pending.agentEnd = undefined;
	pending.handedBack = false;
	items.push({ ...answers, ...(answeredAt !== undefined ? { timestamp: answeredAt } : {}) });
}

function appendConversationMessage(message: AgentMessage, items: ConversationItem[], pending: PendingState, completedAt?: number): void {
	if (message.role === "assistant") {
		appendAssistantMessage(message, items, pending);
	}
	if (message.role === "toolResult" && message.toolName === QUESTION_TOOL) {
		const asked = pending.questions.get(message.toolCallId);
		pending.questions.delete(message.toolCallId);
		const answers = questionAnswers(message, asked);
		if (answers) {
			appendAnswers(answers, items, pending, validTime(message.timestamp) ?? completedAt);
			return;
		}
		if (asked?.length) {
			appendActivity(items, pending, completedAt ?? validTime(message.timestamp));
			items.push({ role: "notice", text: "The questions were not shown to the user." });
		}
	}
	if (message.role === "assistant" || message.role === "toolResult") {
		if (pending.turnStart !== undefined) pending.agentEnd = completedAt ?? validTime(message.timestamp) ?? pending.agentEnd;
		pending.handedBack = message.role === "assistant" && message.stopReason !== "toolUse" && message.stopReason !== "pending";
		return;
	}
	const item = conversationItem(message);
	if (!item) return;
	const receivedAt = completedAt ?? validTime(message.timestamp);
	closeAgentSection(items, pending, { receivedAt, sentAt: validTime(message.timestamp) });
	pending.turnStart = receivedAt;
	pending.agentEnd = undefined;
	pending.handedBack = false;
	items.push(item);
}

function buildConversation(entries: readonly SessionEntry[]): {
	items: ConversationItem[];
	persisted: Set<AgentMessage>;
	pendingActivity: PendingState;
} {
	const items: ConversationItem[] = [];
	const persisted = new Set<AgentMessage>();
	const pendingActivity = pendingState();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		persisted.add(entry.message);
		appendConversationMessage(entry.message, items, pendingActivity, entryTime(entry));
	}
	return { items, persisted, pendingActivity };
}

export function conversationItems(entries: readonly SessionEntry[], live?: ConversationMessage): ConversationItem[] {
	const { items, persisted, pendingActivity } = buildConversation(entries);
	// Pi emits message_end before appending the message to SessionManager. The
	// finalized message is the same object it appends, so identity avoids duplicates.
	if (live && !persisted.has(live)) appendConversationMessage(live, items, pendingActivity);
	appendActivity(items, pendingActivity, pendingActivity.agentEnd);
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
		forEachAssistantPart(message, () => stats.agentMessages++, (type) => {
			if (type === "thinking") stats.thinkingBlocks++;
			else stats.toolCalls++;
		}, () => stats.toolCalls++);
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

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

/**
 * Rows have two blank columns on each side. The layout paints the divider and
 * scrollbar over the outer column of each pair, so rows must begin and end
 * with a literal space.
 */
const ROW_GUTTER = 2;

function paneRow(text: string, width: number): string {
	const gutter = " ".repeat(ROW_GUTTER);
	return width <= ROW_GUTTER * 2 ? " ".repeat(width) : `${gutter}${truncateToWidth(text, width - ROW_GUTTER * 2, "", true)}${gutter}`;
}

function renderMessageHeader(
	message: Omit<ConversationMessageItem, "text"> & { detail?: string },
	width: number,
	theme: Theme,
	hasPriorMessage: boolean,
): string[] {
	const lines = [paneRow("", width)];
	if (hasPriorMessage) lines.push(paneRow("", width));
	const contentWidth = Math.max(1, width - ROW_GUTTER * 2);
	const label = message.role === "user" ? "User" : "Agent";
	const color = message.role === "user" ? "syntaxType" : "warning";
	const timestamp = messageTimestamp(message.timestamp);
	const model = message.role === "assistant" && message.model ? ` ${theme.fg(color, `(${message.model})`)}` : "";
	const stamp = timestamp ? ` ${theme.fg("dim", timestamp)}` : "";
	const detail = message.detail ? ` ${theme.fg("dim", `· ${message.detail}`)}` : "";
	for (const wrapped of wrapTextWithAnsi(theme.fg(color, theme.bold(label)) + model + detail + stamp, contentWidth)) {
		lines.push(paneRow(wrapped, width));
	}
	lines.push(paneRow(theme.fg(color, "─".repeat(contentWidth)), width));
	return lines;
}

function activitySummary(activity: Omit<ConversationActivityItem, "role">, theme: Theme): string {
	const toolCalls = `${activity.toolCalls} tool call${activity.toolCalls === 1 ? "" : "s"}`;
	const thinkingBlocks = `${activity.thinkingBlocks} thinking block${activity.thinkingBlocks === 1 ? "" : "s"}`;
	const duration = activity.elapsedMs !== undefined ? ` · ${formatElapsed(activity.elapsedMs)}` : "";
	return theme.fg("success", theme.italic(toolCalls)) + theme.fg("dim", theme.italic(`, ${thinkingBlocks}${duration}`));
}

/** Wraps `text` below `first`, continuing at `indent` columns. */
function hangingRows(first: string, text: string, indent: number, contentWidth: number): string[] {
	const rest = " ".repeat(indent);
	return wrapTextWithAnsi(text, Math.max(1, contentWidth - indent)).map((row, index) => (index === 0 ? first : rest) + row);
}

function renderQuestions(item: ConversationQuestionsItem, contentWidth: number, theme: Theme): string[] {
	const rows: string[] = [];
	const indent = Math.min(2, contentWidth - 1);
	for (const [index, question] of item.questions.entries()) {
		if (index > 0) rows.push("");
		const mode = question.multiSelect ? theme.fg("dim", " (select any)") : "";
		rows.push(...wrapTextWithAnsi(theme.fg("accent", theme.bold(`? ${question.header ?? "Question"}`)) + mode, contentWidth));
		const markdown = new Markdown(question.question, 0, 0, getMarkdownTheme());
		for (const row of markdown.render(Math.max(1, contentWidth - indent))) rows.push(" ".repeat(indent) + row);
		for (const option of question.options) {
			rows.push(...hangingRows(`${" ".repeat(indent)}${theme.fg("dim", "•")} `, option, indent + 2, contentWidth));
		}
	}
	return rows;
}

function renderAnswers(item: ConversationAnswersItem, contentWidth: number, theme: Theme): string[] {
	const rows: string[] = [];
	const subdued = (text: string) => theme.fg("dim", theme.italic(text));
	if (item.declined) rows.push(...wrapTextWithAnsi(subdued("Declined to answer"), contentWidth));
	else {
		for (const answer of item.answers) {
			const reply = answer.answer ?? subdued("(no answer)");
			rows.push(...wrapTextWithAnsi(`${theme.fg("syntaxType", theme.bold(answer.label))} ${theme.fg("dim", "→")} ${reply}`, contentWidth));
			if (answer.notes) rows.push(...hangingRows("  ", subdued(`note: ${answer.notes}`), 2, contentWidth));
		}
	}
	if (item.note) rows.push(...wrapTextWithAnsi(subdued(`Note: ${item.note}`), contentWidth));
	return rows;
}

function renderItems(messages: readonly ConversationItem[], width: number, theme: Theme, hasPriorContent = false): string[] {
	const lines: string[] = [];
	const contentWidth = Math.max(1, width - ROW_GUTTER * 2);
	let hasContent = hasPriorContent;
	const appendSummary = (text: string) => {
		for (const wrapped of wrapTextWithAnsi(text, contentWidth)) lines.push(paneRow(wrapped, width));
	};
	for (const message of messages) {
		if (message.role === "questions") {
			lines.push(paneRow("", width));
			for (const row of renderQuestions(message, contentWidth, theme)) lines.push(paneRow(row, width));
			continue;
		}
		if (message.role === "answers") {
			lines.push(...renderMessageHeader({ role: "user", timestamp: message.timestamp, detail: "answered" }, width, theme, hasContent));
			hasContent = true;
			for (const row of renderAnswers(message, contentWidth, theme)) lines.push(paneRow(row, width));
			continue;
		}
		if (message.role === "notice") {
			lines.push(paneRow("", width));
			appendSummary(theme.fg("dim", theme.italic(message.text)));
			continue;
		}
		if (message.role === "agent-start") {
			lines.push(...renderMessageHeader({ ...message, role: "assistant" }, width, theme, hasContent));
			hasContent = true;
			continue;
		}
		if (message.role === "activity") {
			lines.push(paneRow("", width));
			appendSummary(activitySummary(message, theme));
			continue;
		}
		if (message.role === "agent-end") {
			lines.push(paneRow(theme.fg("warning", "─".repeat(contentWidth)), width));
			const elapsed = [
				...(message.agentMs !== undefined ? [`Agent turn ${formatElapsed(message.agentMs)}`] : []),
				...(message.userMs !== undefined ? [`User turn ${formatElapsed(message.userMs)}`] : []),
			];
			const time = elapsed.length ? theme.fg("dim", theme.italic(` · ${elapsed.join(" · ")}`)) : "";
			appendSummary(theme.fg("dim", theme.italic("Total: ")) + activitySummary(message, theme) + time);
			continue;
		}
		if (message.role === "user") {
			lines.push(...renderMessageHeader(message, width, theme, hasContent));
			hasContent = true;
		} else {
			lines.push(paneRow("", width));
		}
		const markdown = new Markdown(message.text, 0, 0, getMarkdownTheme());
		for (const row of markdown.render(contentWidth)) lines.push(paneRow(row, width));
	}
	return lines;
}

/** Read-only view of the active session branch, including the current streamed message. */
export class ConversationPane implements Component {
	private live?: ConversationMessage;
	private agentRunning = false;
	private revision = 0;
	private history?: {
		width: number;
		leaf: string | null;
		entryCount: number;
		lastEntry?: SessionEntry;
		lines: string[];
		hasContent: boolean;
		persisted: Set<AgentMessage>;
		pendingActivity: PendingState;
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

	/** A running section has no closing rule or totals footer. */
	setAgentRunning(running: boolean): void {
		if (this.agentRunning === running) return;
		this.agentRunning = running;
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
					appendConversationMessage(entry.message, appendedItems, history.pendingActivity, entryTime(entry));
				}
				if (appendedItems.length > 0) {
					history.lines.push(...renderItems(appendedItems, w, this.theme, history.hasContent));
					history.hasContent = history.lines.length > 0;
				}
				history.entryCount += appended.length;
				history.lastEntry = appended.at(-1) ?? history.lastEntry;
				history.leaf = leaf;
			} else {
				const branch = this.session.getBranch();
				const { items, persisted, pendingActivity } = buildConversation(branch);
				const rendered = renderItems(items, w, this.theme);
				history = {
					width: w,
					leaf,
					entryCount: branch.length,
					lastEntry: branch.at(-1),
					lines: rendered,
					hasContent: rendered.length > 0,
					persisted,
					pendingActivity,
				};
				this.history = history;
			}
		}

		const tailItems: ConversationItem[] = [];
		// The idle footer is provisional: later agent messages can extend the
		// same section, so closing the live tail must not close persisted history.
		const pendingActivity = { ...history.pendingActivity, questions: new Map(history.pendingActivity.questions) };
		if (this.live && !history.persisted.has(this.live)) {
			appendConversationMessage(this.live, tailItems, pendingActivity);
		}
		if (this.agentRunning) appendActivity(tailItems, pendingActivity, pendingActivity.agentEnd);
		else closeAgentSection(tailItems, pendingActivity);
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
		if (tailItems.length > 0) composed.lines.push(...renderItems(tailItems, w, this.theme, history.hasContent));
		if (composed.lines.length === 0) composed.lines.push(paneRow(this.theme.fg("dim", "No messages yet"), w));
		this.cached = { width: w, leaf, revision: this.revision, lines: composed.lines };
		return composed.lines;
	}
}
