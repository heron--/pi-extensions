import assert from "node:assert/strict";
import test from "node:test";
import { ARGUMENT_PLACEHOLDERS, argumentSpans, CALL_LIMITS, compactArguments, expandedArguments, formatToolArguments } from "./arguments.ts";
import { summarizeCommand, summarizeToolCall } from "./summaries.ts";

/** `kind(text)` for tinted spans, bare text otherwise. */
const spanSketch = (text) =>
	argumentSpans(text).map((span) => (span.kind === "text" ? span.text : `${span.kind}(${span.text})`)).join("");

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
		fieldLines: [0, 2],
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

test("generated descriptors split into measure, unit and separator spans", () => {
	assert.equal(spanSketch("288 B · 1 line"), "measure(288) unit(B)separator( · )measure(1) unit(line)");
	assert.equal(spanSketch("11.7 KB · 1002 lines"), "measure(11.7) unit(KB)separator( · )measure(1002) unit(lines)");
	// `array`/`object` lead their descriptor as a type word rather than a count.
	assert.equal(spanSketch("array · 10000 items"), "unit(array)separator( · )measure(10000) unit(items)");
	assert.equal(spanSketch("object · 100+ fields"), "unit(object)separator( · )measure(100+) unit(fields)");
	// The spans reassemble into exactly the original text.
	for (const text of ["288 B · 1 line", "array · 4 items", "object · 2 fields"]) {
		assert.equal(argumentSpans(text).map((span) => span.text).join(""), text);
	}
});

test("only generated placeholders are tinted, never lookalike literals", () => {
	for (const label of Object.values(ARGUMENT_PLACEHOLDERS)) {
		assert.equal(spanSketch(label), `placeholder(${label})`);
	}
	assert.equal(spanSketch("node -e <inline script>"), "node -e placeholder(<inline script>)");
	// Literal values that merely resemble a label keep the plain value color.
	for (const literal of ['["open","owned"]', "cmd --flag=[x]", "[Redacted]", "[A]", "<Foo>", "a · b", "288 B", "1 line", "12n", "2 questions · Which?"]) {
		assert.equal(spanSketch(literal), literal);
	}
	assert.deepEqual(argumentSpans(""), []);
});

test("descriptor spans reach the renderer for real oversized arguments", () => {
	const preview = compactArguments({ command: "x".repeat(288) });
	assert.equal(preview.text, "command: 288 B · 1 line");
	assert.equal(spanSketch("288 B · 1 line"), "measure(288) unit(B)separator( · )measure(1) unit(line)");
	assert.equal(compactArguments({ items: Array(4).fill({ a: "x".repeat(200) }) }).text, "items: array · 4 items");
	assert.equal(spanSketch("array · 4 items"), "unit(array)separator( · )measure(4) unit(items)");
});

test("expanded arguments report which lines begin a field", () => {
	const script = "import os\nprint('hello')";
	const preview = expandedArguments({ code: script, limit: 5 });
	assert.equal(preview.text, "code: import os\nprint('hello')\nlimit: 5");
	// Line 1 continues `code`; line 2 starts `limit`.
	assert.deepEqual(preview.fieldLines, [0, 2]);

	// A body line that mimics `key: value` is still a continuation, by position.
	const spoof = expandedArguments({ command: "path: /etc/passwd\nlimit: 99", timeout: 5 });
	assert.deepEqual(spoof.fieldLines, [0, 2]);

	// Pretty-printed trees count their own line breaks.
	const nested = expandedArguments({ nested: { enabled: true }, after: 1 });
	assert.equal(nested.text, 'nested: {\n  "enabled": true\n}\nafter: 1');
	assert.deepEqual(nested.fieldLines, [0, 3]);

	assert.deepEqual(expandedArguments({}).fieldLines, [0]);
	// A lone value has no field structure, so every line continues it.
	assert.deepEqual(expandedArguments("text").fieldLines, []);
	const proxy = new Proxy({}, { ownKeys() { throw new Error("no access"); } });
	assert.deepEqual(expandedArguments(proxy).fieldLines, [0]);
});

test("field line indices stay aligned with the rendered text", () => {
	for (const args of [
		{ a: "1\n2\n3", b: "x", c: { d: [1, 2] } },
		{ only: "no newlines" },
		{ first: "a", second: "b\nc", third: "d\ne\nf" },
	]) {
		const { text, fieldLines } = expandedArguments(args);
		const lines = text.split("\n");
		for (const [index, key] of Object.keys(args).entries()) {
			const at = fieldLines[index];
			assert.ok(at !== undefined, `missing field line for ${key}`);
			assert.ok(lines[at].startsWith(`${key}: `), `line ${at} should start field ${key}, got ${lines[at]}`);
		}
		// Every non-field line is a continuation of the field above it.
		assert.equal(fieldLines.length, Object.keys(args).length);
	}
});
