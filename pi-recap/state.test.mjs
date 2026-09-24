import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRecapConfig, updateRecapConfig } from "./config-store.ts";
import {
	RecapStore,
	aggregateUsage,
	createRecapKey,
	formatConversation,
	selectRecapSlice,
} from "./state.ts";
import {
	isValidIntervalMinutes,
	isValidMinimumCompletedInteractions,
	normalizeRecapSettings,
} from "./settings.ts";

const zeroUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const usage = (input, output, total) => ({
	input,
	output,
	cacheRead: 2,
	cacheWrite: 3,
	reasoning: 1,
	totalTokens: input + output + 5,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total },
});

const userEntry = (id, text) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: `2026-01-01T00:00:0${id}.000Z`,
	message: { role: "user", content: text, timestamp: 0 },
});

const assistantEntry = (id, text, messageUsage = zeroUsage()) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: `2026-01-01T00:00:0${id}.000Z`,
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: messageUsage,
		stopReason: "stop",
		timestamp: 0,
	},
});

test("normalizeRecapSettings accepts configured timer values and rejects invalid values", () => {
	assert.deepEqual(
		normalizeRecapSettings({ intervalMinutes: 12.5, minimumCompletedInteractions: 8 }),
		{ intervalMinutes: 12.5, minimumCompletedInteractions: 8 },
	);
	assert.deepEqual(
		normalizeRecapSettings({ intervalMinutes: -1, minimumCompletedInteractions: 2.5 }),
		{ intervalMinutes: 5, minimumCompletedInteractions: 5 },
	);
	assert.equal(isValidIntervalMinutes(0.05), true);
	assert.equal(isValidIntervalMinutes(0.01), false);
	assert.equal(isValidMinimumCompletedInteractions(1), true);
	assert.equal(isValidMinimumCompletedInteractions(0), false);
});

test("updateRecapConfig atomically merges changed fields with the latest config", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-recap-config-test-"));
	try {
		const path = join(root, "config.json");
		writeFileSync(
			path,
			`${JSON.stringify({
				markers: { recap: "R" },
				intervalMinutes: 15,
				minimumCompletedInteractions: 8,
				rotationIndex: 2,
				futureSetting: true,
			})}\n`,
		);
		updateRecapConfig(path, (current) => ({
			rotationIndex: Number(current.rotationIndex) + 1,
			markers: { next: "N" },
		}));
		const updated = readRecapConfig(path);
		assert.deepEqual(updated.markers, { recap: "R", next: "N" });
		assert.equal(updated.intervalMinutes, 15);
		assert.equal(updated.minimumCompletedInteractions, 8);
		assert.equal(updated.rotationIndex, 3);
		assert.equal(updated.futureSetting, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createRecapKey produces a sortable filename-safe timestamp", () => {
	assert.equal(createRecapKey(new Date("2026-08-12T17:05:06.123Z")), "20260812T170506123Z");
});

test("selectRecapSlice advances from the manifest cursor to the latest message", () => {
	const branch = [
		userEntry("1", "first"),
		assistantEntry("2", "one"),
		{ type: "custom", id: "3", parentId: "2", timestamp: "2026-01-01T00:00:03.000Z", customType: "x" },
		userEntry("4", "second"),
		assistantEntry("5", "two"),
		{ type: "model_change", id: "6", parentId: "5", timestamp: "2026-01-01T00:00:06.000Z", provider: "p", modelId: "m" },
	];
	const slice = selectRecapSlice(branch, { entryId: "2", timestamp: branch[1].timestamp });

	assert.deepEqual(slice.entries.map((entry) => entry.id), ["3", "4", "5"]);
	assert.equal(slice.completedInteractions, 1);
	assert.equal(slice.messages, 2);
	assert.deepEqual(slice.cursor, { entryId: "5", timestamp: branch[4].timestamp });
});

test("selectRecapSlice counts a tool-heavy user round trip as one completed interaction", () => {
	const branch = [
		userEntry("1", "inspect the project"),
		{
			...assistantEntry("2", ""),
			message: {
				...assistantEntry("2", "").message,
				content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } }],
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "3",
			parentId: "2",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 0,
			},
		},
		assistantEntry("4", "done"),
	];

	const slice = selectRecapSlice(branch, null);
	assert.equal(slice.completedInteractions, 1);
	assert.equal(slice.messages, 4);
});

test("selectRecapSlice starts at the branch root when a cursor is no longer on the branch", () => {
	const branch = [userEntry("1", "first"), assistantEntry("2", "reply")];
	const slice = selectRecapSlice(branch, { entryId: "gone", timestamp: "2025-01-01T00:00:00.000Z" });
	assert.deepEqual(slice.entries.map((entry) => entry.id), ["1", "2"]);
});

test("formatConversation keeps complete visible conversation content without image payloads or hidden thinking", () => {
	const entries = [
		{
			...userEntry("1", "ignored"),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Please inspect the build" },
					{ type: "image", mimeType: "image/png", data: "private-base64" },
				],
				timestamp: 0,
			},
		},
		{
			...assistantEntry("2", "ignored"),
			message: {
				...assistantEntry("2", "ignored").message,
				content: [
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "text", text: "I found the issue." },
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "src/a.ts" } },
				],
			},
		},
		{
			type: "message",
			id: "3",
			parentId: "2",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "full tool output" }],
				isError: false,
				timestamp: 0,
			},
		},
	];

	const text = formatConversation(entries);
	assert.match(text, /Please inspect the build/);
	assert.match(text, /\[image: image\/png\]/);
	assert.match(text, /\[tool call\] read \{"path":"src\/a\.ts"\}/);
	assert.match(text, /full tool output/);
	assert.doesNotMatch(text, /private-base64|private chain of thought/);
});

test("aggregateUsage records all token and cost information available in the summarized range", () => {
	const entries = [
		assistantEntry("1", "reply", usage(10, 4, 0.37)),
		{
			type: "compaction",
			id: "2",
			parentId: "1",
			timestamp: "2026-01-01T00:00:02.000Z",
			summary: "summary",
			firstKeptEntryId: "1",
			tokensBefore: 20,
			usage: usage(5, 2, 0.22),
		},
	];
	const total = aggregateUsage(entries);
	assert.equal(total.input, 15);
	assert.equal(total.output, 6);
	assert.equal(total.cacheRead, 4);
	assert.equal(total.cacheWrite, 6);
	assert.equal(total.reasoning, 2);
	assert.equal(total.totalTokens, 31);
	assert.ok(Math.abs(total.cost.total - 0.59) < 1e-9);
});

test("RecapStore writes configured timer settings and reconciles orphaned recap logs", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-recap-test-"));
	try {
		const store = new RecapStore(root, "session-1", "/tmp/session.jsonl", 720_000, 7);
		const initial = store.update((manifest) => {
			manifest.timer.lastCheckedAt = "2026-01-01T00:00:00.000Z";
			return manifest;
		});
		assert.equal(initial.timer.intervalMs, 720_000);
		assert.equal(initial.timer.minimumCompletedInteractions, 7);
		assert.equal(initial.errorActive, false);
		assert.deepEqual(initial.recapLogKeys, []);

		const failed = store.update((manifest) => {
			manifest.errorActive = true;
			manifest.lastError = {
				at: "2026-01-01T00:01:00.000Z",
				message: "generation failed",
				stack: "Error: generation failed\n    at recap",
			};
			return manifest;
		});
		assert.equal(failed.errorActive, true);
		assert.equal(failed.lastError.stack, "Error: generation failed\n    at recap");

		const key = "20260101T001000000Z";
		store.saveLog({
			schemaVersion: 1,
			key,
			generatedAt: "2026-01-01T00:10:00.000Z",
			summary: "Recap: complete\nNext: continue",
			model: { provider: "test", id: "model", name: "Test Model" },
			usage: zeroUsage(),
			sourceUsage: zeroUsage(),
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
			source: {
				previousCursor: null,
				cursor: { entryId: "last", timestamp: "2026-01-01T00:09:59.000Z" },
				completedInteractions: 5,
				messages: 10,
				entryIds: ["first", "last"],
				previousRecapLogKeys: [],
			},
		});

		const reconciled = store.read();
		assert.deepEqual(reconciled.recapLogKeys, [key]);
		assert.equal(reconciled.cursor.entryId, "last");
		assert.equal(store.readRecentLogs(reconciled.recapLogKeys, 5)[0].summary, "Recap: complete\nNext: continue");
		assert.match(readFileSync(store.manifestPath, "utf8"), /"lastCheckedAt": "2026-01-01T00:00:00.000Z"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
