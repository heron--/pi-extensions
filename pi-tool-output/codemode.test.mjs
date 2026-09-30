import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { callArgumentsComponent } from "./call-rendering.ts";
import { CODEMODE_LIMITS, codemodeCallsComponent, codemodeFullOutputNotice, codemodeOutput } from "./codemode.ts";

initTheme("dark", false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const call = (name, args, fields = {}) => ({ id: "nested/1", name, args: JSON.stringify(args), status: "ok", ...fields });
const render = (calls, expanded = false, width = 200, selectedTheme = theme) =>
	codemodeCallsComponent({ calls }, expanded, selectedTheme, 8).render(width).join("\n");

test("codemode hides even short scripts and offers expansion while pending", () => {
	const args = { code: 'text("SOURCE_ONLY")' };
	const collapsed = callArgumentsComponent("codemode", args, false, theme).render(100).join("\n");
	assert.match(collapsed, /JavaScript/);
	assert.match(collapsed, /to expand/);
	assert.doesNotMatch(collapsed, /SOURCE_ONLY/);
	assert.match(callArgumentsComponent("codemode", args, true, theme).render(100).join("\n"), /SOURCE_ONLY/);
	assert.equal(args.code, 'text("SOURCE_ONLY")');
});

test("recorded nested arguments reuse shell, path/range, search, and MCP summaries", () => {
	const output = render([
		call("bash", { command: "git status --short --branch; git diff --stat; git diff --check; git log -1", timeout: 20 }, { durationMs: 25 }),
		call("read", { path: "lib/box.ts", offset: 10, limit: 20 }),
		call("grep", { pattern: "TODO", path: "src" }),
		call("mcp__linear__list_issues", { query: "renderer" }),
	]);
	assert.match(output, /✓ Run Command · git status --short --branch ; git diff --stat ; git diff --check … · timeout: 20 · 25ms/);
	assert.match(output, /✓ Read File · path: lib\/box.ts:10-29/);
	assert.match(output, /✓ Search Files · pattern: \/TODO\/ · path: src/);
	assert.match(output, /✓ Linear List Issues · query: renderer/);
});

test("nested shell bodies stay masked until expanded", () => {
	const calls = [call("bash", { command: "env TOKEN=SECRET node -e 'BODY_ONLY'" })];
	const compact = render(calls);
	assert.match(compact, /TOKEN=… node -e <inline script>/);
	assert.doesNotMatch(compact, /SECRET|BODY_ONLY/);
	const expanded = render(calls, true);
	assert.match(expanded, /command: env TOKEN=SECRET node -e 'BODY_ONLY'/);
});

test("running, failed, cancelled, and unknown statuses cannot look successful", () => {
	const tones = [];
	const colored = { ...theme, fg(color, text) { tones.push([color, text]); return text; } };
	const output = render([
		call("read", { path: "pending" }, { status: "running" }),
		call("read", { path: "missing" }, { status: "error", error: "permission denied\nstack details" }),
		call("read", { path: "cancelled" }, { status: "cancelled" }),
		call("read", { path: "unknown" }, { status: "unexpected" }),
	], false, 200, colored);
	assert.match(output, /… Read File · path: pending/);
	assert.match(output, /✗ Read File · path: missing/);
	assert.match(output, /permission denied stack details/);
	assert.match(output, /⊘ Read File · path: cancelled/);
	assert.match(output, /\? Read File · path: unknown/);
	for (const [color, text] of [["warning", "…"], ["error", "✗"], ["muted", "⊘"], ["muted", "?"]]) {
		assert.ok(tones.some(([c, t]) => c === color && t === text));
	}
	assert.ok(tones.some(([color, text]) => color === "error" && text.includes("permission denied")));
});

test("incomplete native argument previews are never evaluated or guessed", () => {
	const args = '{"command":"node -e \'BODY_ONLY\'';
	const calls = [{ name: "bash", args, status: "ok" }];
	assert.match(render(calls), /arguments preview incomplete/);
	assert.doesNotMatch(render(calls), /BODY_ONLY/);
	assert.match(render(calls, true), /BODY_ONLY/);
	const executable = 'globalThis.CODEMODE_RENDER_EXECUTED = true';
	assert.match(render([{ name: "bash", args: executable, status: "ok" }], true), /CODEMODE_RENDER_EXECUTED/);
	assert.equal(globalThis.CODEMODE_RENDER_EXECUTED, undefined);
});

test("classifier identity, durations, and reported costs remain visible", () => {
	const calls = [
		{ name: "models.classify", args: "provider/model", status: "ok", durationMs: 1234, cost: 0.002 },
		{ name: "models.classify", args: "provider/model", status: "ok", durationMs: 2, cost: 0.01 },
	];
	const output = render(calls);
	assert.match(output, /Classify · provider\/model · 1.2s · \$0.0020/);
	assert.match(output, /Model calls: \$0.01/);
	assert.doesNotMatch(render(Array(10).fill(calls[0])), /Model calls:/);
	assert.doesNotMatch(render([call("read", {}, { durationMs: -1, cost: Infinity })]), /Infinity|-1ms/);
});

test("large call histories and nested arguments stay bounded after wrapping", () => {
	const calls = Array.from({ length: 1000 }, (_, i) => call("read", { path: `file-${i}` }));
	const compact = render(calls);
	assert.match(compact, /992 earlier calls/);
	assert.match(compact, /file-999/);
	assert.doesNotMatch(compact, /path: file-0\b/);
	const huge = [...calls, call("read", { path: "界🙂".repeat(20_000) })];
	for (const expanded of [false, true]) {
		for (const width of [1, 2, 8, 12, 22, 26, 40, 100]) {
			const component = codemodeCallsComponent({ calls: huge }, expanded, theme, 8);
			const rows = component.render(width);
			assert.ok(rows.length <= (expanded ? CODEMODE_LIMITS.expandedRows + 1 : 18));
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `over-wide at ${width}: ${row}`);
			assert.equal(component.render(width), rows);
			component.invalidate();
			assert.deepEqual(component.render(width), rows);
		}
	}
	assert.match(render(calls, true, 100), /display capped/);
	assert.match(render(calls, true, 100), /nested call details capped/);
	assert.match(render([huge.at(-1)], true, 100), /nested call details capped/);
	assert.match(render([call("read", {}, { status: "error", error: "x".repeat(4000) })], true, 5000), /nested call details capped/);
});

test("terminal control sequences are stripped from every nested metadata field", () => {
	const control = "\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2J\x00";
	const calls = [
		call(`custom${control}`, { path: `safe${control}path` }, { status: "error", error: `bad${control}error` }),
		{ name: "models.classify", args: `provider${control}/model`, status: "ok" },
		{ name: "raw", args: `bad JSON${control}`, status: "ok" },
	];
	for (const expanded of [false, true]) {
		assert.doesNotMatch(render(calls, expanded), /\x1b\]52|\x1b\[2J|\x00|Y2xpcGJvYXJk/);
	}
	assert.doesNotMatch(codemodeFullOutputNotice({ fullOutputPath: `/tmp/${control}out` }), /\x1b|\x00|Y2xpcGJvYXJk/);
});

test("missing or malformed details gracefully fall back to script output", () => {
	for (const details of [undefined, null, [], {}, { calls: null }, { calls: [null, {}, "bad", 42] }]) {
		assert.deepEqual(codemodeCallsComponent(details, false, theme, 8).render(80), []);
	}
	assert.doesNotThrow(() => render([call("read", null), call("read", 42), call("read", [])]));
	assert.equal(codemodeFullOutputNotice(undefined), undefined);
	assert.equal(codemodeFullOutputNotice({ fullOutputPath: 42 }), undefined);
});

test("native headers are compressed without mutating results or dropping images/errors", () => {
	const image = { type: "image", data: "pixel", mimeType: "image/png" };
	for (const status of ["completed", "failed"]) {
		const result = {
			content: [{ type: "text", text: `Script ${status}\nWall time 0.2 seconds\nOutput:\n` },
				{ type: "text", text: "partial output\nScript error:\nproblem" }, image],
			details: { calls: [], fullOutputPath: "/tmp/full-output" }, isError: status === "failed",
		};
		const before = structuredClone(result);
		const output = codemodeOutput(result);
		assert.equal(output.content[0].text, `Script ${status} · 0.2s`);
		assert.equal(output.content[1], result.content[1]);
		assert.equal(output.content[2], image);
		assert.equal(output.isError, result.isError);
		assert.deepEqual(result, before);
	}
	for (const result of [{ content: [] }, { content: [{ type: "text", text: "Script completed: user output" }] },
		{ content: [{ type: "text", text: "Invalid options" }] }]) {
		assert.equal(codemodeOutput(result), result);
	}
	assert.equal(codemodeFullOutputNotice({ fullOutputPath: "/tmp/full-output" }), "↳ full output: /tmp/full-output");
});
