// Grouped layout, driven through pi's real ToolExecutionComponent inside a real
// pi-tui Container — the same seam pi's chat uses. Loaded through jiti, like pi.
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pi-tool-output-group-"));

void (async () => {
	const paths = JSON.parse(readFileSync(path.resolve("tsconfig.paths.json"), "utf8")).compilerOptions.paths;
	const piRoot = path.dirname(path.dirname(paths["@earendil-works/pi-coding-agent"][0]));
	const fromPi = createRequire(path.join(piRoot, "package.json"));
	const { createJiti } = require(fromPi.resolve("jiti"));
	const jiti = createJiti(__filename, {
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": path.join(piRoot, "dist/index.js"),
			"@earendil-works/pi-tui": fromPi.resolve("@earendil-works/pi-tui"),
		},
	});
	const codingAgent = await jiti.import(path.join(piRoot, "dist/index.js"));
	const piTui = await jiti.import(fromPi.resolve("@earendil-works/pi-tui"));
	codingAgent.initTheme(undefined, false);
	const prototype = codingAgent.ToolExecutionComponent.prototype;
	const originalRender = prototype.render;
	const originalHandleMouse = prototype.handleMouse;

	const group = await jiti.import(path.resolve("pi-tool-output/group.ts"));
	assert.equal(group.formatBytes(512), "512 B");
	assert.equal(group.formatBytes(3482), "3.4 KB");
	assert.equal(group.formatBytes(5 * 1024 * 1024), "5.0 MB");
	assert.deepEqual(group.outputSize("a\nb\nc\n"), { lines: 3, bytes: 5 });
	assert.deepEqual(group.outputSize("(no output)"), { lines: 0, bytes: 0 });
	assert.equal(group.sizeText({ lines: 1, bytes: 12 }), "1 line, 12 B");
	assert.equal(group.sizeText({ lines: 0, bytes: 0 }), "no output");

	const factory = await jiti.import(path.resolve("pi-tool-output/index.ts"), { default: true });
	const tools = new Map();
	const shortcuts = new Map();
	const handlers = new Map();
	factory({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
		on(name, handler) { handlers.set(name, handler); },
	});
	assert.ok(shortcuts.has("alt+o"), "the expand-last shortcut is registered");
	await handlers.get("session_start")({ type: "session_start" }, { mode: "tui", ui: { notify() {} } });

	let renders = 0;
	const chat = new piTui.Container();
	const ui = { children: [chat], requestRender() { renders++; } };
	const screen = (width = 100) => piTui.stripTerminalSequences(chat.render(width).join("\n"));
	const addTool = (name, id, args, output, isError = false) => {
		const component = new codingAgent.ToolExecutionComponent(
			name, id, args, { showImages: false },
			tools.get(name) ??
				(name === "edit" ? codingAgent.createEditToolDefinition(process.cwd())
					: name === "write" ? codingAgent.createWriteToolDefinition(process.cwd()) : undefined),
			ui, process.cwd(),
		);
		chat.addChild(component);
		component.setArgsComplete();
		component.markExecutionStarted();
		if (output !== undefined) component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError });
		return component;
	};
	/** A tool-only assistant message renders nothing and must not split a run. */
	const emptyRow = { render: () => [], invalidate() {} };

	const readOutput = Array.from({ length: 12 }, (_v, i) => `READ_LINE_${i}`).join("\n");
	const read = addTool("read", "r1", { path: "lib/box.ts", offset: 10, limit: 20 }, readOutput);
	chat.addChild(emptyRow);
	const grep = addTool("grep", "g1", { pattern: "TODO", path: "src" }, "a.ts:1: TODO\nb.ts:2: TODO");
	const bash = addTool("bash", "b1", { command: "npm test" }, "BASH_OUTPUT\nsecond");

	let text = screen();
	assert.match(text, /Ran 3 tools/);
	assert.equal(text.match(/╭/g)?.length, 1, "one box for the whole run");
	// First row: icon, name, summary, output size. The summary's fields are not repeated below.
	const rowsOf = (screenText) => screenText.split("\n").map((line) => line.replace(/^│|│\s*$/g, ""));
	const at = (screenText, needle) => rowsOf(screenText).findIndex((row) => row.includes(needle));
	const textRows = rowsOf(text);
	const readName = at(text, "Read File");
	assert.match(textRows[readName], /Read File\s+path: lib\/box\.ts:10-29  12 lines, \d+ B\s*$/);
	assert.match(textRows[readName + 1], /Search Files/, "no argument row: the summary covers path, offset and limit");
	const nameColumn = textRows[readName].indexOf("Read File");
	assert.notEqual(textRows[readName].slice(0, nameColumn).trim(), "", "an icon precedes the name");
	const grepName = at(text, "Search Files");
	assert.match(textRows[grepName], /Search Files\s+pattern: \/TODO\/ · path: src  2 lines, 25 B/);
	assert.equal(
		textRows[grepName].indexOf("pattern:"),
		textRows[readName].indexOf("path:"),
		"summaries form one column",
	);
	assert.doesNotMatch(text, /READ_LINE_0|BASH_OUTPUT/, "collapsed rows show no output");
	assert.equal(text.match(/to expand all/g)?.length, 1, "only the most recent call carries the hint");
	const lines = text.split("\n");
	const hint = lines.findIndex((line) => line.includes("to expand all"));
	assert.ok(lines[hint - 1].includes("npm test"), "the hint sits under the most recent call");
	assert.deepEqual(grep.render(100), [], "followers draw nothing");
	assert.deepEqual(bash.render(100), []);

	// A click on a row expands only that call.
	const rows = read.render(100);
	const grepRow = rows.findIndex((row) => piTui.stripTerminalSequences(row).includes("TODO"));
	const event = { type: "click", button: "left", x: 4, y: grepRow, screenX: 4, screenY: grepRow, width: 100, height: rows.length, shift: false, alt: false, ctrl: false };
	assert.deepEqual(read.handleMouse(event), { handled: true });
	assert.equal(grep.expanded, true);
	assert.equal(read.expanded, false);
	assert.ok(renders > 0);
	text = screen();
	assert.match(text, /b\.ts:2: TODO/);
	assert.doesNotMatch(text, /READ_LINE_0|BASH_OUTPUT/);
	assert.equal(read.handleMouse({ ...event, type: "move" }), undefined);

	// The shortcut toggles only the most recent call.
	await shortcuts.get("alt+o").handler({});
	assert.equal(bash.expanded, true);
	text = screen();
	assert.match(text, /BASH_OUTPUT/);
	assert.match(text, /alt\+o to collapse/);
	// A later call does not collapse the one expanded before it.
	const ls = addTool("ls", "l1", { path: "." }, "one\ntwo\nthree");
	text = screen();
	assert.match(text, /Ran 4 tools/);
	assert.match(text, /BASH_OUTPUT/);
	assert.match(text, /alt\+o to expand · ctrl\+o to expand all/);
	assert.equal(text.match(/to expand all/g)?.length, 1);
	await shortcuts.get("alt+o").handler({});
	assert.equal(ls.expanded, true);
	assert.equal(bash.expanded, true);

	// Ctrl+O sets every call (pi's setToolsExpanded walks the chat's children).
	for (const component of [read, grep, bash, ls]) component.setExpanded(false);
	text = screen();
	assert.doesNotMatch(text, /BASH_OUTPUT|b\.ts:2/);

	// Anything that draws a row ends the run; a pending call says so.
	chat.addChild(new piTui.Text("assistant prose", 0, 0));
	const pending = addTool("read", "r2", { path: "next.ts" });
	text = screen();
	assert.equal(text.match(/╭/g)?.length, 2);
	assert.match(text, /Running 1 tool/);
	assert.match(text, /running…/);
	assert.match(text, /assistant prose/);
	pending.updateResult({ content: [{ type: "text", text: "boom" }], details: {}, isError: true });
	assert.match(screen(), /failed · 1 line, 4 B/);

	// A call with an input measures it before the output; the rest of its arguments show only expanded.
	chat.addChild(new piTui.Text("more prose", 0, 0));
	const script = `python3 - <<'PY'\n${"print(1)\n".repeat(40)}PY`;
	const scripted = addTool("bash", "b2", { command: script, timeout: 120 }, "SCRIPT_OUT");
	let rows3 = rowsOf(screen());
	const scriptRow = at(screen(), "heredoc");
	assert.match(rows3[scriptRow], /42 lines, 379 B · 1 line, 10 B\s*$/);
	assert.doesNotMatch(screen(), /timeout/, "leftover arguments stay hidden while collapsed");
	scripted.setExpanded(true);
	rows3 = rowsOf(screen());
	assert.match(rows3[scriptRow + 1], /^\s+timeout: 120\s*$/, "expanded shows leftover arguments first");
	assert.match(rows3[scriptRow + 2], /^\s+command: python3 - <<'PY'\s*$/, "then the input in full");
	assert.equal(rows3.filter((row) => row.includes("print(1)")).length, 40);
	const outputRow = rows3.findIndex((row) => row.includes("SCRIPT_OUT"));
	assert.equal(rows3[outputRow - 1].trim(), "", "a blank row separates input from output");
	assert.ok(outputRow > rows3.findIndex((row) => row.includes("print(1)")), "then the output");
	assert.equal(rows3.filter((row) => row.includes("timeout")).length, 1, "expanded does not repeat the arguments");

	// An edit shows +added -removed instead of sizes, and no argument row.
	chat.addChild(new piTui.Text("edit prose", 0, 0));
	const diff = [" 1 // top", "-2 const A = 1;", "+2 const A = 2;", "+3 const B = 3;"].join("\n");
	const edited = addTool("edit", "e1", { path: "lib/box.ts", edits: [{ oldText: "const A = 1;", newText: "const A = 2;\nconst B = 3;" }] });
	edited.updateResult({ content: [{ type: "text", text: "Successfully replaced 1 block(s)." }], details: { diff } });
	const pendingEdit = addTool("edit", "e2", { path: "big.ts", edits: [{ oldText: "a\nb", newText: "x\n".repeat(1200) }] });
	let editRows = rowsOf(screen());
	const editRow = at(screen(), "Edit File");
	assert.match(editRows[editRow], /Edit File\s+path: lib\/box\.ts  \+2 -1\s*$/);
	assert.match(editRows[editRow + 1], /Edit File\s+path: big\.ts  \+1,200 -2\s*$/, "pending edits count from the arguments");
	assert.doesNotMatch(screen(), /edits:|Successfully replaced/);
	assert.equal(group.fileChanges({ toolName: "read", args: {} }), undefined);
	assert.deepEqual(
		group.fileChanges({ toolName: "edit", args: { edits: [{ oldText: "a\n", newText: "b\n" }] } }),
		{ added: 1, removed: 1 },
		"a trailing newline is not an extra line",
	);
	edited.setExpanded(true);
	editRows = rowsOf(screen());
	assert.match(editRows[editRow + 1], /^\s+1 │ \/\/ top\s*$/, "expanded shows the diff, numbered in a gutter");
	assert.match(editRows[editRow + 2], /▌\s+2 │ const A = 1;/, "the removed line, marked");
	assert.match(editRows[editRow + 3], /▌\s+2 │ const A = 2;/, "then the lines replacing it");
	assert.match(editRows[editRow + 4], /▌\s+3 │ const B = 3;/);
	assert.doesNotMatch(screen(), /edit lib\/box\.ts/, "without pi's own edit header");
	assert.doesNotMatch(screen(), /newText|oldText/, "an edit does not repeat its input");
	const wide = rowsOf(screen(160));
	const header = wide.findIndex((row) => /\bold\b.*│.*\bnew\b/.test(row));
	assert.ok(header > 0, "a wide view puts old and new side by side");
	assert.match(wide[header + 2], /▌\s+2 │ const A = 1;\s+│ ▌\s+2 │ const A = 2;/, "a removed line faces its replacement");
	assert.match(wide[header + 3], /^\s+│\s+│ ▌\s+3 │ const B = 3;/, "an added line with nothing opposite faces a blank cell");
	edited.setExpanded(false);
	// A pending edit is previewed against the file, read from the call's working directory.
	pendingEdit.setExpanded(true);
	assert.match(screen(), /pending edit/);
	assert.match(screen(), /Preview not shown: the file does not exist\./);
	pendingEdit.setExpanded(false);

	const workspace = mkdtempSync(path.join(tmpdir(), "pi-tool-output-preview-"));
	writeFileSync(path.join(workspace, "a.ts"), "one\ntwo\nthree\n");
	const call = (name, id, args, complete = true) => {
		const component = new codingAgent.ToolExecutionComponent(
			name, id, args, { showImages: false }, tools.get(name), ui, workspace,
		);
		chat.addChild(new piTui.Text(`${id} prose`, 0, 0));
		chat.addChild(component);
		if (complete) component.setArgsComplete();
		component.setExpanded(true);
		return component;
	};
	const previewed = call("edit", "p1", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
	assert.match(screen(), /pending edit[\s\S]*▌\s+2 │ two[\s\S]*▌\s+2 │ TWO/, "a pending edit's preview diff");
	previewed.setExpanded(false);
	const streaming = call("edit", "p2", { path: "a.ts", edits: [{ oldText: "tw" }] }, false);
	assert.match(screen(), /pending edit/);
	assert.doesNotMatch(screen(), /Preview not shown: the edit/, "nothing is read while the arguments stream");
	streaming.setExpanded(false);
	const ambiguous = call("edit", "p3", { path: "a.ts", edits: [{ oldText: "o", newText: "0" }] });
	assert.match(screen(), /Preview not shown: the edit matches more than one place\./);
	ambiguous.setExpanded(false);
	writeFileSync(path.join(path.dirname(workspace), "outside-secret.ts"), "secret\n");
	const outside = call("edit", "p4", { path: "../outside-secret.ts", edits: [{ oldText: "secret", newText: "x" }] });
	assert.match(screen(), /Preview not shown: it is outside the working directory\./, "a preview reads only the working directory");
	outside.setExpanded(false);
	const creating = call("write", "p5", { path: "new.md", content: "first\nsecond\n" });
	assert.match(screen(), /pending create[\s\S]*▌\s+1 │ first[\s\S]*▌\s+2 │ second/);
	creating.setExpanded(false);
	const overwriting = call("write", "p6", { path: "a.ts", content: "one\nTWO\nthree\n" });
	assert.match(screen(), /pending overwrite[\s\S]*▌\s+2 │ two[\s\S]*▌\s+2 │ TWO/);
	overwriting.setExpanded(false);

	// A finished write shows the change it recorded, which survives a reload.
	const created = call("write", "w2", { path: "notes.md", content: "N1\nN2\nN3\n" });
	created.updateResult({ content: [{ type: "text", text: "Successfully wrote to notes.md" }], details: { created: true } });
	assert.match(screen(), /Write File\s+path: notes\.md  \+3 -0/);
	assert.match(screen(), /new file[\s\S]*▌\s+1 │ N1[\s\S]*▌\s+3 │ N3/);
	created.setExpanded(false);
	const overwrote = call("write", "w3", { path: "a.ts", content: "one\nTWO\nthree\n" });
	overwrote.updateResult({
		content: [{ type: "text", text: "Successfully wrote to a.ts" }],
		details: { created: false, diff: " 1 one\n-2 two\n+2 TWO\n 3 three" },
	});
	assert.match(screen(), /Write File\s+path: a\.ts  \+1 -1/);
	assert.match(screen(), /▌\s+2 │ two[\s\S]*▌\s+2 │ TWO/);
	assert.doesNotMatch(screen(), /new file[\s\S]*TWO/);
	overwrote.setExpanded(false);
	// A failed edit shows its error rather than a diff.
	const failed = call("edit", "f1", { path: "a.ts", edits: [{ oldText: "zzz", newText: "y" }] });
	failed.updateResult({ content: [{ type: "text", text: "Could not find the exact text in a.ts." }], details: {}, isError: true });
	assert.match(screen(), /Could not find the exact text in a\.ts\./);
	failed.setExpanded(false);

	// An edit drawn by another extension keeps that extension's view.
	const elsewhere = {
		...codingAgent.createEditToolDefinition(process.cwd()),
		renderCall: () => new piTui.Text("THIRD_PARTY_DIFF_VIEW", 0, 0),
		renderResult: () => new piTui.Text("", 0, 0),
	};
	const thirdParty = new codingAgent.ToolExecutionComponent(
		"edit", "e3", { path: "c.ts", edits: [{ oldText: "a", newText: "b" }] }, { showImages: false }, elsewhere, ui, process.cwd(),
	);
	chat.addChild(thirdParty);
	thirdParty.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b" } });
	assert.doesNotMatch(screen(), /THIRD_PARTY_DIFF_VIEW/);
	assert.match(screen(), /path: c\.ts  \+1 -1/);
	thirdParty.setExpanded(true);
	assert.match(screen(), /THIRD_PARTY_DIFF_VIEW/);
	thirdParty.setExpanded(false);

	// A write that recorded no change, such as pi's own, shows its sizes and does not repeat its input.
	const written = addTool("write", "w1", { path: "notes.md", content: "WRITTEN_BODY\n".repeat(30) }, "Successfully wrote 390 bytes");
	assert.match(screen(), /Write File\s+path: notes\.md  30 lines, 389 B · 1 line, 28 B/);
	written.setExpanded(true);
	assert.doesNotMatch(screen(), /WRITTEN_BODY/);
	written.setExpanded(false);

	// An unchanged frame reuses the group's rows instead of rebuilding them; a change rebuilds.
	bash.setExpanded(true);
	const frame = read.render(100);
	assert.equal(read.render(100), frame, "unchanged frames reuse the cached rows");
	grep.setExpanded(true);
	assert.notEqual(read.render(100), frame, "a member's change rebuilds the group");
	grep.setExpanded(false);
	bash.setExpanded(false);

	// A call outside the groups (a tool that keeps its own renderer) takes the
	// "most recent" role away from the last grouped call: no stale hint or target.
	const ownRenderer = new codingAgent.ToolExecutionComponent(
		"custom_unmapped", "u1", {}, { showImages: false },
		{ name: "custom_unmapped", renderCall: () => new piTui.Text("CUSTOM_ROW", 0, 0) }, ui, process.cwd(),
	);
	chat.addChild(ownRenderer);
	assert.match(screen(), /CUSTOM_ROW/);
	assert.doesNotMatch(screen(), /to expand all|alt\+o to collapse/, "no grouped call keeps the hint");
	const expandedBefore = chat.children.filter((c) => c.expanded).length;
	await shortcuts.get("alt+o").handler({});
	assert.equal(chat.children.filter((c) => c.expanded).length, expandedBefore, "Alt+O does not reach past it");

	// A long display name is cut to the name column, never the sizes after it.
	const houseCall = () => new piTui.Text("", 0, 0);
	houseCall[Symbol.for("pi-tool-output.house-renderer.v1")] = true;
	const longName = new codingAgent.ToolExecutionComponent(
		"custom_long", "long", {}, { showImages: false },
		{ name: "custom_long", label: "An Extremely Long Display Name That Would Crowd Out Everything Else", renderCall: houseCall },
		ui, process.cwd(),
	);
	chat.addChild(new piTui.Text("long-name prose", 0, 0));
	chat.addChild(longName);
	longName.updateResult({ content: [{ type: "text", text: "x" }], details: {} });
	for (const width of [100, 60]) {
		const rows = piTui.stripTerminalSequences(longName.render(width).join("\n")).split("\n");
		const row = rows.find((line) => line.includes("An Extremely"));
		assert.match(row ?? "", width < 80 ? /…\s+1 line, 1 B/ : /Everything Else\s+1 line, 1 B/, `the size survives a long name at ${width}`);
	}

	// Expanded arguments rebuild their baked-in colors when the theme changes.
	const themed = addTool("bash", "theme1", { command: "true", timeout: 5 }, "ok");
	themed.setExpanded(true);
	const fakeTheme = (tag) => ({
		fg: (_color, text) => `<${tag}>${text}`, bg: (_color, text) => text, bold: (text) => text,
		getBgAnsi: () => "", getFgAnsi: () => "", getColorMode: () => "truecolor",
	});
	const renderWith = (tag) =>
		group.renderGroup([themed], 100, { theme: fakeTheme(tag), lastMember: undefined, expandLastKey: "alt+o" })
			.lines.find((line) => line.includes("timeout")) ?? "";
	assert.match(renderWith("A"), /<A>/);
	assert.match(renderWith("B"), /<B>/, "a theme switch repaints the expanded arguments");
	assert.doesNotMatch(renderWith("B"), /<A>/);
	themed.setExpanded(false);

	// Never wider than the terminal, at any width.
	bash.setExpanded(true);
	edited.setExpanded(true);
	previewed.setExpanded(true);
	for (const width of [120, 60, 30, 14, 8]) {
		for (const row of chat.render(width)) {
			assert.ok(piTui.visibleWidth(row) <= width, `row exceeds ${width}: ${JSON.stringify(row)}`);
		}
	}

	await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
	assert.equal(prototype.render, originalRender);
	assert.equal(prototype.handleMouse, originalHandleMouse);
	console.log("tool-output group fixture passed");
})()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});
