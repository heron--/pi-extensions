import assert from "node:assert/strict";
import test from "node:test";
import { CALL_LIMITS, compactArguments, expandedArguments, formatToolArguments } from "./arguments.ts";
import { summarizeCommand, summarizeToolCall } from "./summaries.ts";

test("oversized strings and multiline payloads become size/line descriptors", () => {
	const script = "// private payload\n".repeat(500);
	const preview = compactArguments({ workflowScript: script, async: true });
	assert.equal(preview.hidden, true);
	assert.match(preview.text, /workflowScript: [\d.]+ KB · 501 lines · async: true/);
	assert.doesNotMatch(preview.text, /private payload/);
	assert.match(formatToolArguments({ prompt: "hello\nworld" }), /prompt: 11 B · 2 lines/);
	assert.match(formatToolArguments({ text: "界".repeat(200) }), /600 B/);
	assert.equal(compactArguments({ text: "a".repeat(160) }).hidden, false);
	assert.equal(compactArguments({ text: "a".repeat(161) }).hidden, true);
});

test("large arrays, wide/deep JSON and many fields are bounded without serializing the full tree", () => {
	assert.match(formatToolArguments({ items: Array(10_000).fill("payload") }), /array · 10000 items/);
	assert.match(formatToolArguments({ sparse: Array(10_000) }), /array · 10000 items/);
	assert.match(formatToolArguments({ filters: { payload: "x".repeat(100_000) } }), /object · 1 fields/);
	let nested = {};
	for (let i = 0; i < 1000; i++) nested = { nested };
	assert.match(formatToolArguments({ nested }), /object/);
	assert.equal(expandedArguments(nested).hidden, true);
	const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, i]));
	assert.match(formatToolArguments(many), /… more arguments/);
	assert.doesNotMatch(formatToolArguments(many), /field8:/);
	assert.equal(compactArguments(many).hidden, true);
	const hugeKey = { ["key".repeat(50_000)]: true };
	assert.ok(formatToolArguments(hugeKey).length < 200);
});

test("cycles, bigints, toJSON hooks, accessors and uninspectable shapes degrade safely", () => {
	const circular = {}; circular.self = circular;
	assert.match(formatToolArguments({ circular }), /object/);
	assert.match(expandedArguments(circular).text, /circular/);
	assert.equal(formatToolArguments({ bigint: 12n }), "bigint: 12n");
	const hooks = { toJSON() { throw Error("must not call"); } };
	Object.defineProperty(hooks, "danger", { enumerable: true, get() { throw Error("must not call"); } });
	assert.match(expandedArguments(hooks).text, /\[accessor\]/);
	const proxy = new Proxy({}, { ownKeys() { throw Error("no access"); } });
	assert.equal(compactArguments(proxy).text, "[arguments unavailable]");
	assert.equal(expandedArguments(proxy).text, "[arguments unavailable]");
});

test("expanded arguments preserve string layout and disclose caps", () => {
	const payload = "first line\n  second line";
	assert.deepEqual(expandedArguments({ code: payload, nested: { enabled: true } }), {
		text: 'code: first line\n  second line\nnested: {\n  "enabled": true\n}', hidden: false,
	});
	for (const args of [{ code: "x".repeat(1_000_000) }, { items: Array(100_000).fill({ x: "value" }) }]) {
		const preview = expandedArguments(args);
		assert.equal(preview.hidden, true);
		assert.ok(preview.text.length <= CALL_LIMITS.expandedChars);
	}
});

test("argument text cannot inject terminal controls and small values remain useful", () => {
	for (const format of [compactArguments, expandedArguments]) {
		const preview = format({ text: "safe\x1b]52;c;Zm9v\x07text\x1b[2J\x00" });
		assert.match(preview.text, /safetext/);
		assert.doesNotMatch(preview.text, /\x1b|\x00|Zm9v/);
	}
	assert.equal(formatToolArguments({ query: "house boxes", limit: 5, filters: ["open", "owned"] }), 'query: house boxes · limit: 5 · filters: ["open","owned"]');
});

test("summaries retain built-in ranges and search scope without duplicating small fields", () => {
	const args = { path: "lib/box.ts", offset: 10, limit: 20 };
	const summary = summarizeToolCall("read", args);
	assert.equal(summary.text, "path: lib/box.ts:10-29");
	assert.equal(compactArguments(args, summary.fields).text, "");
	assert.equal(summarizeToolCall("grep", { pattern: "TODO", path: "src", glob: "*.ts" }).text, "pattern: /TODO/ · path: src · glob: *.ts");
	assert.equal(summarizeToolCall("find", { pattern: "*.ts" }).text, "pattern: *.ts · path: .");
	assert.equal(summarizeToolCall("web_search", { query: "Pi docs", intent: "docs" }).text, "Pi docs · docs");
});

test("shell sketches understand chains, quoted separators, environment and inline/heredoc scripts", () => {
	assert.equal(summarizeCommand("cd /tmp/repo && npm run check"), "cd /tmp/repo && npm run check");
	assert.equal(summarizeCommand("git diff --stat | head -20"), "git diff --stat | head -20");
	assert.equal(summarizeCommand("printf '%s' 'a;b && c'"), "printf '%s' 'a;b && c'");
	assert.equal(summarizeCommand("CI=1 npm test"), "CI=… npm test");
	assert.equal(summarizeCommand('node -e "console.log(42)"'), "node -e <inline script>");
	assert.equal(summarizeCommand("python3 - <<'PY'\nprint('sensitive body')\nPY"), "python3 - · heredoc script");
	assert.doesNotMatch(summarizeCommand("python3 -c '" + "sensitive".repeat(2000) + "'"), /sensitive/);
	assert.equal(summarizeCommand("# comment\nnpm test\ngit diff"), "npm test ; git diff");
	assert.ok(summarizeCommand("unknown " + "arg ".repeat(10_000)).length <= 241);
	assert.doesNotThrow(() => summarizeCommand("echo 'unterminated"));
});

test("recognized adapters summarize explicit metadata rather than embedded tasks/scripts", () => {
	assert.equal(summarizeToolCall("subagent", { agent: "reviewer", task: "private" }).text, "agent: reviewer");
	assert.match(summarizeToolCall("subagent", {
		workflowScript: "private ".repeat(1000), async: true, worktree: true,
		preflight: { lanes: [{ key: "inspect" }, { key: "test" }] },
	}).text, /Scripted workflow · 2 declared lanes: inspect, test · async · worktree/);
	assert.equal(summarizeToolCall("subagent", { workflow: "review" }).text, "workflow: review");
	assert.equal(summarizeToolCall("subagent", { action: "status", id: "run-1" }).text, "status · run-1");
	assert.equal(summarizeToolCall("mcp", { tool: "search_issues", server: "linear", args: { query: "private" } }).text, "linear · search_issues");
	assert.match(summarizeToolCall("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.read" }, { recipient_name: "functions.grep" }] }).text, /2 parallel tools · functions.read, functions.grep/);
	assert.equal(summarizeToolCall("bg_run", { name: "Check build", command: "npm test" }).text, "Check build · npm test");
	assert.equal(summarizeToolCall("fusion_investigate", { objective: "Inspect bug" }).text, "Inspect bug");
	assert.equal(summarizeToolCall("preview_export", { format: "pdf", path: "plan.md" }).text, "PDF · plan.md");
});

test("unknown/partial tool shapes use generic previews and large consumed fields stay discoverable", () => {
	for (const args of [undefined, null, [], { query: {} }, { pattern: 42 }]) {
		assert.equal(summarizeToolCall("unknown", args), undefined);
		assert.doesNotThrow(() => compactArguments(args));
		assert.doesNotThrow(() => summarizeToolCall("subagent", args));
	}
	assert.equal(summarizeToolCall("grep", { pattern: {} }), undefined);
	const malformed = { path: "file.ts", offset: "wrong type", limit: false };
	assert.equal(compactArguments(malformed, summarizeToolCall("read", malformed).fields).text, "offset: wrong type · limit: false");
	const foreground = { agent: "reviewer", async: false, worktree: false };
	assert.equal(compactArguments(foreground, summarizeToolCall("subagent", foreground).fields).text, "async: false · worktree: false");
	const args = { query: "private ".repeat(500) };
	const summary = summarizeToolCall("web_search", args);
	const preview = compactArguments(args, summary.fields);
	assert.equal(preview.hidden, true);
	assert.match(preview.text, /query: [\d.]+ KB/);
});
