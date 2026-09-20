import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { compactArguments } from "./arguments.ts";
import {
	summarizeAskUserQuestion,
	summarizeBackgroundTask,
	summarizeCommand,
	summarizeFileWrite,
	summarizeLs,
	summarizeMcp,
	summarizeNamedTask,
	summarizeParallelTools,
	summarizePreviewExport,
	summarizeRead,
	summarizeSearch,
	summarizeShell,
	summarizeSubagent,
	summarizeToolCall,
	summarizeWebSearch,
} from "./summaries.ts";

test("summarizeRead reports the requested range and needs a path", () => {
	assert.equal(summarizeRead({ path: "lib/box.ts" }).text, "path: lib/box.ts");
	assert.equal(summarizeRead({ path: "a.ts", offset: 10, limit: 20 }).text, "path: a.ts:10-29");
	assert.equal(summarizeRead({ path: "a.ts", offset: 5 }).text, "path: a.ts:5");
	assert.equal(summarizeRead({ path: "a.ts", limit: 10 }).text, "path: a.ts:1-10");
	assert.equal(summarizeRead({ path: `${homedir()}/p/f.ts` }).text, "path: ~/p/f.ts");
	assert.equal(summarizeRead({}), undefined);
	assert.equal(summarizeRead({ path: 42 }), undefined);
});

test("summarizeSearch delimits grep patterns and defaults the scope", () => {
	assert.equal(summarizeSearch("grep", { pattern: "TODO" }).text, "pattern: /TODO/ · path: .");
	assert.equal(summarizeSearch("find", { pattern: "*.ts" }).text, "pattern: *.ts · path: .");
	assert.equal(
		summarizeSearch("grep", { pattern: "x", path: "src", glob: "*.ts" }).text,
		"pattern: /x/ · path: src · glob: *.ts",
	);
	assert.equal(summarizeSearch("grep", {}), undefined);
	assert.equal(summarizeSearch("grep", { pattern: {} }), undefined);
});

test("summarizeLs always reports a directory", () => {
	assert.equal(summarizeLs({ path: "src" }).text, "path: src");
	assert.equal(summarizeLs({}).text, "path: .");
});

test("summarizeShell sketches the command, which always stands in for it", () => {
	assert.deepEqual(summarizeShell({ command: "npm test" }), {
		text: "npm test",
		fields: ["command", "name"],
	});
	assert.equal(summarizeShell({ command: "ls", name: "List" }).text, "List · ls");
	// A rewritten sketch consumes the command too: the original — including
	// anything the sketch masked — must not return via the generic preview.
	assert.deepEqual(summarizeShell({ command: "python3 -c 'x'" }).fields, ["command", "name"]);
	assert.equal(summarizeShell({ command: 42 }), undefined);
	assert.equal(summarizeShell({}), undefined);
});

test("summarizeFileWrite reports the target path and never the payload", () => {
	assert.equal(summarizeFileWrite({ path: "a.ts", content: "secret" }).text, "path: a.ts");
	assert.deepEqual(summarizeFileWrite({ path: "a.ts" }).fields, ["path"]);
	assert.equal(summarizeFileWrite({}), undefined);
});

test("summarizeWebSearch appends intent when present", () => {
	assert.equal(summarizeWebSearch({ query: "Pi docs", intent: "docs" }).text, "Pi docs · docs");
	assert.equal(summarizeWebSearch({ query: "Pi docs" }).text, "Pi docs");
	assert.equal(summarizeWebSearch({}), undefined);
});

test("summarizeSubagent prefers an action, then a dispatch mode, and labels scripts", () => {
	assert.equal(summarizeSubagent({ action: "status", id: "run-1", topic: "t" }).text, "status · run-1 · t");
	assert.equal(summarizeSubagent({ action: "status" }).text, "status");
	assert.equal(summarizeSubagent({ workflow: "review" }).text, "workflow: review");
	assert.deepEqual(summarizeSubagent({ workflow: "review" }).fields, ["workflow"]);
	assert.equal(summarizeSubagent({ agent: "reviewer", task: "private" }).text, "agent: reviewer");
	assert.deepEqual(summarizeSubagent({ agent: "reviewer" }).fields, ["agent"]);
	assert.equal(summarizeSubagent({ workflowScript: "private ".repeat(100) }).text, "Scripted workflow");
	assert.deepEqual(summarizeSubagent({ workflowScript: "private" }).fields, ["workflowScript"]);
	assert.equal(summarizeSubagent({ workflowScriptPath: "p.js" }).text, "workflow: p.js");
	assert.deepEqual(summarizeSubagent({ workflowScriptPath: "p.js" }).fields, ["workflowScriptPath"]);
	assert.equal(summarizeSubagent({}), undefined);
});

test("summarizeSubagent counts declared lanes and flags async/worktree", () => {
	assert.equal(
		summarizeSubagent({ agent: "a", preflight: { lanes: [{ key: "inspect" }, { key: "test" }] } }).text,
		"agent: a · 2 declared lanes: inspect, test",
	);
	assert.equal(
		summarizeSubagent({ agent: "a", preflight: { lanes: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }] } }).text,
		"agent: a · 4 declared lanes: a, b, c, …",
	);
	// Unnamed lanes still report a count.
	assert.equal(summarizeSubagent({ agent: "a", preflight: { lanes: [{}, {}] } }).text, "agent: a · 2 declared lanes");
	assert.equal(summarizeSubagent({ agent: "a", preflight: { lanes: [] } }).text, "agent: a");
	assert.equal(summarizeSubagent({ agent: "a", preflight: "nope" }).text, "agent: a");
	assert.equal(summarizeSubagent({ agent: "a", async: true, worktree: true }).text, "agent: a · async · worktree");
	assert.equal(summarizeSubagent({ agent: "a", async: false }).text, "agent: a");
});

test("summarizeMcp prefers the targeted tool, then gateway fields in priority order", () => {
	assert.equal(summarizeMcp({ tool: "search", server: "linear" }).text, "linear · search");
	assert.equal(summarizeMcp({ tool: "search" }).text, "search");
	assert.equal(summarizeMcp({ action: "install", server: "s" }).text, "action: install");
	assert.equal(summarizeMcp({ query: "q", server: "s" }).text, "query: q");
	assert.equal(summarizeMcp({ server: "s" }).text, "server: s");
	assert.deepEqual(summarizeMcp({ list: true }), { text: "List available tools", fields: ["list"] });
	assert.equal(summarizeMcp({}), undefined);
});

test("summarizeParallelTools counts calls and names the first few", () => {
	assert.equal(
		summarizeParallelTools({ tool_uses: [{ recipient_name: "functions.read" }, { recipient_name: "functions.grep" }] }).text,
		"2 parallel tools · functions.read, functions.grep",
	);
	assert.equal(
		summarizeParallelTools({ tool_uses: Array.from({ length: 5 }, (_v, i) => ({ recipient_name: `t${i}` })) }).text,
		"5 parallel tools · t0, t1, t2, …",
	);
	assert.equal(summarizeParallelTools({ tool_uses: [1, 2] }).text, "2 parallel tools");
	assert.equal(summarizeParallelTools({}), undefined);
});

test("summarizeNamedTask prefers a name over an objective", () => {
	assert.equal(summarizeNamedTask({ name: "N", objective: "O" }).text, "N");
	assert.deepEqual(summarizeNamedTask({ objective: "O" }), { text: "O", fields: ["objective"] });
	assert.equal(summarizeNamedTask({}), undefined);
});

test("summarizeBackgroundTask reports the addressed task", () => {
	assert.equal(summarizeBackgroundTask({ taskId: "task-1" }).text, "task: task-1");
	assert.equal(summarizeBackgroundTask({}), undefined);
});

test("summarizePreviewExport upcases the format and falls back through sources", () => {
	assert.equal(summarizePreviewExport({ format: "pdf", path: "plan.md" }).text, "PDF · plan.md");
	assert.equal(summarizePreviewExport({ format: "png", source: "file" }).text, "PNG · file");
	assert.equal(summarizePreviewExport({ format: "html" }).text, "HTML · latest response");
	assert.equal(summarizePreviewExport({}), undefined);
});

test("summarizeAskUserQuestion counts questions and shows the first", () => {
	assert.equal(summarizeAskUserQuestion({ questions: [{ question: "Which?" }, {}] }).text, "2 questions · Which?");
	assert.equal(summarizeAskUserQuestion({ questions: [] }).text, "0 questions · ");
	assert.equal(summarizeAskUserQuestion({}), undefined);
});

test("summarizeCommand keeps chains and pipelines within bounds", () => {
	assert.equal(summarizeCommand("cd /tmp/repo && npm run check"), "cd /tmp/repo && npm run check");
	assert.equal(summarizeCommand("git diff --stat | head -20"), "git diff --stat | head -20");
	assert.equal(summarizeCommand("a && b && c && d"), "a && b && c …");
	assert.equal(summarizeCommand("# comment\nnpm test\ngit diff"), "npm test ; git diff");
	assert.equal(summarizeCommand(""), "shell command");
	assert.ok(summarizeCommand(`unknown ${"arg ".repeat(10_000)}`).length <= 241);
});

test("summarizeCommand masks environment values and inline interpreter bodies", () => {
	assert.equal(summarizeCommand("CI=1 npm test"), "CI=… npm test");
	assert.equal(summarizeCommand("env FOO=secret node -e 'body'"), "env FOO=… node -e <inline script>");
	// An `env` wrapper hides the interpreter behind its own options and
	// assignments; the executable is still found and its body still masked.
	assert.equal(summarizeCommand("env -i node -e 'body'"), "env -i node -e <inline script>");
	assert.equal(summarizeCommand("/usr/bin/env python -c 'y'"), "/usr/bin/env python -c <inline script>");
	assert.equal(
		summarizeCommand("env -u CI FOO=1 python3 -c 'y'"),
		"env -u CI FOO=… python3 -c <inline script>",
	);
	assert.equal(summarizeCommand('node -e "console.log(42)"'), "node -e <inline script>");
	assert.equal(summarizeCommand("/usr/bin/python3.11 -c 'y'"), "/usr/bin/python3.11 -c <inline script>");
	assert.doesNotMatch(summarizeCommand(`env -i node -e '${"sensitive".repeat(2000)}'`), /sensitive/);
	assert.doesNotMatch(summarizeCommand(`python3 -c '${"sensitive".repeat(2000)}'`), /sensitive/);
});

test("masked shell commands and labeled scripts never resurface in the compact preview", () => {
	// The compact view is the summary row plus the generic preview; neither may
	// carry content the sketch or label stood in for.
	const rows = (name, args) => {
		const summary = summarizeToolCall(name, args);
		assert.ok(summary, `${name} has a summary`);
		return `${summary.text}\n${compactArguments(args, summary.fields).text}`;
	};
	assert.doesNotMatch(rows("bash", { command: "node -e 'SECRET'" }), /SECRET/);
	assert.doesNotMatch(rows("bash", { command: "CI=SECRET npm test" }), /SECRET/);
	assert.doesNotMatch(rows("bash", { command: "env -i node -e 'SECRET'" }), /SECRET/);
	assert.doesNotMatch(rows("bg_run", { command: "/usr/bin/env python -c 'SECRET'" }), /SECRET/);
	assert.doesNotMatch(rows("subagent", { workflowScript: "deploy SECRET" }), /SECRET/);
	assert.doesNotMatch(rows("mcpScript", { code: "tools.call('SECRET')" }), /SECRET/);
	// A long or multi-line command still surfaces a size descriptor, whose
	// contents stay masked; expansion is what reveals them in full.
	const script = "python3 - <<'PY'\nSECRET\nPY";
	assert.match(rows("bash", { command: script }), /command: \d+ B · 3 lines/);
	assert.doesNotMatch(rows("bash", { command: script }), /SECRET/);
	const long = `deploy\n${"SECRET".repeat(100)}`;
	assert.match(rows("subagent", { workflowScript: long }), /workflowScript: \d+ B · 2 lines/);
	assert.doesNotMatch(rows("subagent", { workflowScript: long }), /SECRET/);
});

test("summarizeCommand respects quoting and never reads a heredoc body", () => {
	assert.equal(summarizeCommand("printf '%s' 'a;b && c'"), "printf '%s' 'a;b && c'");
	assert.equal(summarizeCommand("python3 - <<'PY'\nprint('sensitive body')\nPY"), "python3 - · heredoc script");
	assert.doesNotMatch(summarizeCommand("cat <<'E'\nsecret\nE"), /secret/);
	// An unterminated quote is marked incomplete rather than throwing.
	assert.equal(summarizeCommand("echo 'unterminated"), "echo 'unterminated …");
	assert.doesNotThrow(() => summarizeCommand("`backtick`"));
});

test("summarizeToolCall routes each tool family to its summarizer", () => {
	assert.equal(summarizeToolCall("read", { path: "a.ts" }).text, "path: a.ts");
	assert.equal(summarizeToolCall("grep", { pattern: "x" }).text, "pattern: /x/ · path: .");
	assert.equal(summarizeToolCall("ls", {}).text, "path: .");
	assert.equal(summarizeToolCall("bash", { command: "ls" }).text, "ls");
	assert.equal(summarizeToolCall("bg_run", { command: "ls", name: "N" }).text, "N · ls");
	assert.equal(summarizeToolCall("write", { path: "a.ts" }).text, "path: a.ts");
	assert.equal(summarizeToolCall("mcpScript", { code: "c" }).text, "MCP script");
	assert.equal(summarizeToolCall("mcpScript", {}), undefined);
	assert.equal(summarizeToolCall("datadog", { tool: "logs" }).text, "logs");
	assert.equal(summarizeToolCall("mcp__atlassian", { tool: "jira" }).text, "jira");
	assert.equal(summarizeToolCall("fusion_reason", { objective: "O" }).text, "O");
	assert.equal(summarizeToolCall("bg_kill", { taskId: "t" }).text, "task: t");
	assert.equal(summarizeToolCall("unknown_tool", { path: "a.ts" }), undefined);
});

test("summarizeToolCall bounds text and only consumes fields it rendered", () => {
	assert.deepEqual(summarizeToolCall("read", { path: "a.ts", offset: 1, limit: 2 }).fields, ["path", "offset", "limit"]);
	// A non-numeric offset stays in the generic preview.
	assert.deepEqual(summarizeToolCall("read", { path: "a.ts", offset: "x" }).fields, ["path"]);
	assert.deepEqual(summarizeToolCall("subagent", { agent: "a", async: false }).fields, ["agent"]);
	assert.deepEqual(summarizeToolCall("subagent", { agent: "a", async: true }).fields, ["agent", "async"]);
});

test("summarizeToolCall clips an oversized summary and flags it hidden", () => {
	// Individual fields are already clipped to 160 characters, so exceeding the
	// 480-character summary cap takes several long fields.
	const single = summarizeToolCall("web_search", { query: "z".repeat(600) });
	assert.ok(single.text.length <= 161);
	assert.equal(single.hidden, false);

	const wide = summarizeToolCall("grep", {
		pattern: "p".repeat(200), path: "a".repeat(200), glob: "g".repeat(200),
	});
	assert.equal(wide.text.length, 481);
	assert.ok(wide.text.endsWith("…"));
	assert.equal(wide.hidden, true);
});

test("summarizeToolCall degrades to no summary on hostile or partial arguments", () => {
	for (const args of [undefined, null, [], "string", 42, { path: {} }, { pattern: 42 }]) {
		for (const name of ["read", "grep", "ls", "bash", "subagent", "mcp", "preview_export"]) {
			assert.doesNotThrow(() => summarizeToolCall(name, args));
		}
	}
	const throwing = {};
	Object.defineProperty(throwing, "path", { enumerable: true, get() { throw new Error("must not call"); } });
	assert.equal(summarizeToolCall("read", throwing), undefined);
	const proxy = new Proxy({}, { get() { throw new Error("no access"); } });
	assert.equal(summarizeToolCall("read", proxy), undefined);
});
