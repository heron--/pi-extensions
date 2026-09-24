import type { Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;
export const RECAP_LOG_SCHEMA_VERSION = 1;
export const MANIFEST_FILE_NAME = "manifest.json";
export const RECAP_LOG_PREFIX = "recap-log-";

const INTERNAL_LOCK_STALE_MS = 60_000;
const INTERNAL_LOCK_RETRIES = 20;
const INTERNAL_LOCK_RETRY_MS = 10;

export interface RecapCursor {
	entryId: string;
	timestamp: string;
}

export interface TimerLock {
	ownerId: string;
	acquiredAt: string;
}

export interface GenerationLock {
	ownerId: string;
	acquiredAt: string;
}

export interface RecapError {
	at: string;
	message: string;
	stack: string | null;
}

export interface RecapManifest {
	schemaVersion: number;
	sessionId: string;
	sessionFile: string | null;
	recapLogKeys: string[];
	cursor: RecapCursor | null;
	timer: {
		intervalMs: number;
		minimumCompletedInteractions: number;
		lock: TimerLock | null;
		lastCheckedAt: string | null;
	};
	generationLock: GenerationLock | null;
	errorActive: boolean;
	lastError: RecapError | null;
	updatedAt: string;
}

export interface RecapLog {
	schemaVersion: number;
	key: string;
	generatedAt: string;
	summary: string;
	model: {
		provider: string;
		id: string;
		name: string;
	};
	usage: Usage;
	sourceUsage: Usage;
	contextUsage: ContextUsage | null;
	source: {
		previousCursor: RecapCursor | null;
		cursor: RecapCursor;
		completedInteractions: number;
		messages: number;
		entryIds: string[];
		previousRecapLogKeys: string[];
	};
}

export interface RecapSlice {
	entries: SessionEntry[];
	previousCursor: RecapCursor | null;
	cursor: RecapCursor;
	completedInteractions: number;
	messages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeCursor(value: unknown): RecapCursor | null {
	if (!isRecord(value)) return null;
	return typeof value.entryId === "string" && isIsoDate(value.timestamp)
		? { entryId: value.entryId, timestamp: value.timestamp }
		: null;
}

function normalizeTimerLock(value: unknown): TimerLock | null {
	if (!isRecord(value)) return null;
	return typeof value.ownerId === "string" && isIsoDate(value.acquiredAt)
		? { ownerId: value.ownerId, acquiredAt: value.acquiredAt }
		: null;
}

function normalizeGenerationLock(value: unknown): GenerationLock | null {
	return normalizeTimerLock(value);
}

function normalizeError(value: unknown): RecapError | null {
	if (!isRecord(value)) return null;
	if (!isIsoDate(value.at) || typeof value.message !== "string") return null;
	return {
		at: value.at,
		message: value.message,
		stack: typeof value.stack === "string" ? value.stack : null,
	};
}

function defaultManifest(
	sessionId: string,
	sessionFile: string | undefined,
	intervalMs: number,
	minimumCompletedInteractions: number,
	now: Date,
): RecapManifest {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		sessionId,
		sessionFile: sessionFile ?? null,
		recapLogKeys: [],
		cursor: null,
		timer: {
			intervalMs,
			minimumCompletedInteractions,
			lock: null,
			lastCheckedAt: null,
		},
		generationLock: null,
		errorActive: false,
		lastError: null,
		updatedAt: now.toISOString(),
	};
}

function normalizeManifest(
	value: unknown,
	sessionId: string,
	sessionFile: string | undefined,
	intervalMs: number,
	minimumCompletedInteractions: number,
	now: Date,
): RecapManifest {
	const fallback = defaultManifest(sessionId, sessionFile, intervalMs, minimumCompletedInteractions, now);
	if (!isRecord(value)) return fallback;

	const timer = isRecord(value.timer) ? value.timer : {};
	const recapLogKeys = Array.isArray(value.recapLogKeys)
		? [...new Set(value.recapLogKeys.filter((key): key is string => typeof key === "string" && key.length > 0))]
		: [];

	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		sessionId,
		sessionFile: sessionFile ?? (typeof value.sessionFile === "string" ? value.sessionFile : null),
		recapLogKeys,
		cursor: normalizeCursor(value.cursor),
		timer: {
			intervalMs:
				typeof timer.intervalMs === "number" && Number.isFinite(timer.intervalMs) && timer.intervalMs > 0
					? timer.intervalMs
					: intervalMs,
			minimumCompletedInteractions:
				typeof timer.minimumCompletedInteractions === "number" &&
				Number.isInteger(timer.minimumCompletedInteractions) &&
				timer.minimumCompletedInteractions > 0
					? timer.minimumCompletedInteractions
					: typeof timer.minimumAgentTurns === "number" &&
						  Number.isInteger(timer.minimumAgentTurns) &&
						  timer.minimumAgentTurns > 0
						? timer.minimumAgentTurns
						: minimumCompletedInteractions,
			lock: normalizeTimerLock(timer.lock),
			lastCheckedAt: isIsoDate(timer.lastCheckedAt) ? timer.lastCheckedAt : null,
		},
		generationLock: normalizeGenerationLock(value.generationLock),
		errorActive: typeof value.errorActive === "boolean" ? value.errorActive : normalizeError(value.lastError) !== null,
		lastError: normalizeError(value.lastError),
		updatedAt: isIsoDate(value.updatedAt) ? value.updatedAt : fallback.updatedAt,
	};
}

function sleepSync(milliseconds: number): void {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

function recapKeyFromFileName(fileName: string): string | null {
	if (!fileName.startsWith(RECAP_LOG_PREFIX) || !fileName.endsWith(".json")) return null;
	const key = fileName.slice(RECAP_LOG_PREFIX.length, -".json".length);
	return key || null;
}

function isRecapLog(value: unknown): value is RecapLog {
	if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.source)) return false;
	return (
		typeof value.key === "string" &&
		isIsoDate(value.generatedAt) &&
		typeof value.summary === "string" &&
		typeof value.model.provider === "string" &&
		typeof value.model.id === "string" &&
		typeof value.model.name === "string" &&
		normalizeCursor(value.source.cursor) !== null
	);
}

export class RecapStore {
	readonly directory: string;
	readonly manifestPath: string;
	private readonly internalLockPath: string;
	private readonly sessionId: string;
	private readonly sessionFile: string | undefined;
	private readonly intervalMs: number;
	private readonly minimumCompletedInteractions: number;

	constructor(
		baseDirectory: string,
		sessionId: string,
		sessionFile: string | undefined,
		intervalMs: number,
		minimumCompletedInteractions: number,
	) {
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.intervalMs = intervalMs;
		this.minimumCompletedInteractions = minimumCompletedInteractions;
		const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
		this.directory = join(baseDirectory, "sessions", safeSessionId);
		this.manifestPath = join(this.directory, MANIFEST_FILE_NAME);
		this.internalLockPath = join(this.directory, ".manifest-write.lock");
	}

	logPath(key: string): string {
		return join(this.directory, `${RECAP_LOG_PREFIX}${key}.json`);
	}

	private readManifestFile(now = new Date()): RecapManifest {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.manifestPath, "utf8"));
		} catch {
			parsed = undefined;
		}
		return normalizeManifest(
			parsed,
			this.sessionId,
			this.sessionFile,
			this.intervalMs,
			this.minimumCompletedInteractions,
			now,
		);
	}

	private listLogKeys(): string[] {
		try {
			return readdirSync(this.directory)
				.map(recapKeyFromFileName)
				.filter((key): key is string => key !== null)
				.sort();
		} catch {
			return [];
		}
	}

	private reconcile(manifest: RecapManifest): RecapManifest {
		const keys = [...new Set([...manifest.recapLogKeys, ...this.listLogKeys()])].sort();
		let cursor = manifest.cursor;

		for (let index = keys.length - 1; index >= 0; index -= 1) {
			const log = this.readLog(keys[index]!);
			if (!log) continue;
			cursor = log.source.cursor;
			break;
		}

		return { ...manifest, recapLogKeys: keys, cursor };
	}

	read(now = new Date()): RecapManifest {
		return this.reconcile(this.readManifestFile(now));
	}

	update(mutator: (manifest: RecapManifest) => RecapManifest | void, now = new Date()): RecapManifest {
		mkdirSync(this.directory, { recursive: true });
		return this.withInternalLock(() => {
			const manifest = this.reconcile(this.readManifestFile(now));
			const updated = mutator(manifest) ?? manifest;
			const normalized = normalizeManifest(
				updated,
				this.sessionId,
				this.sessionFile,
				this.intervalMs,
				this.minimumCompletedInteractions,
				now,
			);
			normalized.updatedAt = now.toISOString();
			writeJsonAtomic(this.manifestPath, normalized);
			return normalized;
		});
	}

	saveLog(log: RecapLog): void {
		writeJsonAtomic(this.logPath(log.key), log);
	}

	readLog(key: string): RecapLog | null {
		try {
			const parsed = JSON.parse(readFileSync(this.logPath(key), "utf8"));
			return isRecapLog(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	readRecentLogs(keys: string[], count: number): RecapLog[] {
		const logs: RecapLog[] = [];
		for (let index = keys.length - 1; index >= 0 && logs.length < count; index -= 1) {
			const log = this.readLog(keys[index]!);
			if (log) logs.push(log);
		}
		return logs.reverse();
	}

	private withInternalLock<T>(operation: () => T): T {
		for (let attempt = 0; attempt < INTERNAL_LOCK_RETRIES; attempt += 1) {
			let descriptor: number | undefined;
			try {
				descriptor = openSync(this.internalLockPath, "wx");
				try {
					return operation();
				} finally {
					closeSync(descriptor);
					unlinkSync(this.internalLockPath);
				}
			} catch (error) {
				if (descriptor !== undefined) {
					try {
						closeSync(descriptor);
					} catch {
						// The descriptor was already closed.
					}
				}
				const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
				if (code !== "EEXIST") throw error;

				try {
					if (Date.now() - statSync(this.internalLockPath).mtimeMs > INTERNAL_LOCK_STALE_MS) {
						unlinkSync(this.internalLockPath);
						continue;
					}
				} catch {
					continue;
				}
				sleepSync(INTERNAL_LOCK_RETRY_MS);
			}
		}
		throw new Error(`Timed out waiting for recap manifest lock: ${this.internalLockPath}`);
	}
}

export function createRecapKey(at: Date): string {
	return at.toISOString().replace(/[-:.]/g, "");
}

export function selectRecapSlice(branch: SessionEntry[], previousCursor: RecapCursor | null): RecapSlice | null {
	const previousIndex = previousCursor
		? branch.findIndex((entry) => entry.id === previousCursor.entryId)
		: -1;
	const startIndex = previousIndex >= 0 ? previousIndex + 1 : 0;
	let endIndex = -1;

	for (let index = branch.length - 1; index >= startIndex; index -= 1) {
		if (branch[index]!.type === "message") {
			endIndex = index;
			break;
		}
	}
	if (endIndex < startIndex) return null;

	const entries = branch.slice(startIndex, endIndex + 1);
	const endpoint = branch[endIndex]!;
	let waitingUsers = 0;
	let completedInteractions = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			waitingUsers += 1;
		} else if (entry.message.role === "assistant" && waitingUsers > 0) {
			completedInteractions += waitingUsers;
			waitingUsers = 0;
		}
	}
	const messages = entries.filter((entry) => entry.type === "message").length;

	return {
		entries,
		previousCursor,
		cursor: { entryId: endpoint.id, timestamp: endpoint.timestamp },
		completedInteractions,
		messages,
	};
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function contentLines(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const part of content) {
		if (!isRecord(part) || typeof part.type !== "string") continue;
		if (part.type === "text" && typeof part.text === "string") {
			lines.push(part.text);
		} else if (part.type === "image") {
			lines.push(`[image${typeof part.mimeType === "string" ? `: ${part.mimeType}` : ""}]`);
		} else if (part.type === "toolCall" && typeof part.name === "string") {
			lines.push(`[tool call] ${part.name} ${stringify(part.arguments ?? {})}`);
		}
	}
	return lines;
}

export function formatConversation(entries: SessionEntry[]): string {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			const lines: string[] = [];
			if (message.role === "user") {
				lines.push(...contentLines(message.content));
			} else if (message.role === "assistant") {
				lines.push(...contentLines(message.content));
				if (message.errorMessage) lines.push(`[assistant error] ${message.errorMessage}`);
			} else if (message.role === "toolResult") {
				lines.push(`[tool result: ${message.toolName}${message.isError ? ", error" : ""}]`);
				lines.push(...contentLines(message.content));
			} else if (message.role === "bashExecution") {
				lines.push(`$ ${message.command}`);
				if (message.output) lines.push(message.output);
				lines.push(`[exit: ${message.exitCode ?? "unknown"}${message.cancelled ? ", cancelled" : ""}]`);
			} else if (message.role === "custom") {
				lines.push(...contentLines(message.content));
			} else if (message.role === "branchSummary") {
				lines.push(message.summary);
			} else if (message.role === "compactionSummary") {
				lines.push(message.summary);
			}
			if (lines.length > 0) {
				sections.push(`<message id="${entry.id}" role="${message.role}" at="${entry.timestamp}">\n${lines.join("\n")}\n</message>`);
			}
			continue;
		}

		if (entry.type === "compaction") {
			sections.push(`<compaction id="${entry.id}" at="${entry.timestamp}">\n${entry.summary}\n</compaction>`);
		} else if (entry.type === "branch_summary") {
			sections.push(`<branch-summary id="${entry.id}" at="${entry.timestamp}">\n${entry.summary}\n</branch-summary>`);
		} else if (entry.type === "custom_message") {
			const lines = contentLines(entry.content);
			if (lines.length > 0) {
				sections.push(`<custom-message id="${entry.id}" at="${entry.timestamp}">\n${lines.join("\n")}\n</custom-message>`);
			}
		}
	}

	return sections.join("\n\n");
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
}

export function aggregateUsage(entries: SessionEntry[]): Usage {
	const total = emptyUsage();
	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
				addUsage(total, entry.message.usage);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(total, entry.usage);
		}
	}
	return total;
}
