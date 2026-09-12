import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import {
	countNonEmptyLines,
	displayToolName,
	extractTextOutput,
	formatToolArguments,
	isKnownToolName,
	isLikelyQuietCommand,
	outputLines,
	previewSlice,
	sanitizeAnsiForToolOutput,
	shortenPath,
} from "./rendering.ts";

test("known tool names map to readable house-box labels", () => {
	assert.equal(displayToolName("read"), "Read File");
	assert.equal(displayToolName("multi_tool_use.parallel"), "Parallel Tools");
	assert.equal(displayToolName("mcp__atlassian"), "Atlassian");
	assert.equal(displayToolName("custom_report_tool"), "Custom Report Tool");
	assert.equal(displayToolName("custom", "Unsafe\nLabel\x1b]52;c;Y2xpcGJvYXJk\x07"), "Unsafe Label");
	assert.equal(displayToolName("\x1b[2J"), "Tool");
	assert.equal(isKnownToolName("web_search"), true);
	assert.equal(isKnownToolName("custom_report_tool"), false);
});

test("tool arguments stay on one compact logical line", () => {
	assert.equal(
		formatToolArguments({ query: "house boxes", limit: 5, filters: ["open", "owned"] }),
		'query: house boxes · limit: 5 · filters: ["open","owned"]',
	);
	assert.equal(formatToolArguments({}), "(no arguments)");
});

test("extractTextOutput joins only text blocks", () => {
	assert.equal(
		extractTextOutput({ content: [{ type: "text", text: "one" }, { type: "image", data: "..." }, { type: "text", text: "two" }] }),
		"one\ntwo",
	);
});

test("collapsed lines remove trailing and repeated blank rows", () => {
	assert.deepEqual(outputLines("one\n\n\ntwo\n\n", false), ["one", "", "two"]);
	assert.deepEqual(outputLines("one\n\n\ntwo\n", true), ["one", "", "", "two"]);
});

test("previewSlice reports the hidden line count", () => {
	assert.deepEqual(previewSlice(["a", "b", "c"], 2), { shown: ["a", "b"], remaining: 1 });
	assert.deepEqual(previewSlice(["a"], 0), { shown: [], remaining: 1 });
});

test("line counts ignore blank output", () => {
	assert.equal(countNonEmptyLines(["a", "", "b", "  "]), 2);
});

test("terminal sanitization strips styling and control sequences", () => {
	assert.equal(sanitizeAnsiForToolOutput("\x1b[31;44mred\x1b[0m"), "red");
	assert.equal(sanitizeAnsiForToolOutput("\x1b[38;2;1;2;3;48;5;9mcolor"), "color");
	assert.equal(sanitizeAnsiForToolOutput("\x1b[38:2::255:0:0mcolon\x1b[0m"), "colon");
	assert.equal(sanitizeAnsiForToolOutput("before\x1b[2J\x1b[Hafter"), "beforeafter");
	assert.equal(sanitizeAnsiForToolOutput("safe\x1b]52;c;Y2xpcGJvYXJk\x07text"), "safetext");
});

test("quiet command detection considers the first shell segment", () => {
	assert.equal(isLikelyQuietCommand("git add . && git status"), true);
	assert.equal(isLikelyQuietCommand("printf hello"), false);
});

test("home path abbreviation respects the path boundary", () => {
	assert.equal(shortenPath(homedir()), "~");
	assert.equal(shortenPath(`${homedir()}/project/file.ts`), "~/project/file.ts");
	assert.equal(shortenPath(`${homedir()}-other/file.ts`), `${homedir()}-other/file.ts`);
});
