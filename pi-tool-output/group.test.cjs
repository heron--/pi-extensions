// Grouped layout, driven through pi's real ToolExecutionComponent inside a real
// pi-tui Container — the same seam pi's chat uses. Loaded through jiti, like pi.
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("node:fs");
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
			name, id, args, { showImages: false }, tools.get(name), ui, process.cwd(),
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
	// Two rows per call: icon, name and size, then the summary lined up under the name.
	const rowsOf = (screenText) => screenText.split("\n").map((line) => line.replace(/^│|│\s*$/g, ""));
	const at = (screenText, needle) => rowsOf(screenText).findIndex((row) => row.includes(needle));
	const textRows = rowsOf(text);
	const readName = at(text, "Read File");
	assert.match(textRows[readName], /Read File\s+12 lines, \d+ B\s*$/);
	assert.match(textRows[readName + 1], /^\s+path: lib\/box\.ts:10-29\s*$/);
	const nameColumn = textRows[readName].indexOf("Read File");
	assert.equal(textRows[readName + 1].indexOf("path:"), nameColumn, "summary lines up with the name");
	assert.notEqual(textRows[readName].slice(0, nameColumn).trim(), "", "an icon precedes the name");
	assert.match(text, /a\.ts|TODO/);
	const grepName = at(text, "Search Files");
	assert.match(textRows[grepName + 1], /pattern: \/TODO\/ · path: src/);
	assert.match(textRows[grepName], /2 lines, 25 B/);
	assert.equal(
		textRows[grepName].indexOf("2 lines"),
		textRows[readName].indexOf("12 lines"),
		"sizes form one column",
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

	// Never wider than the terminal, at any width.
	bash.setExpanded(true);
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
