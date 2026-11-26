const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(path.join(tmpdir(), "pi-tool-output-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

void (async () => {
	const paths = JSON.parse(readFileSync(path.resolve("tsconfig.paths.json"), "utf8")).compilerOptions.paths;
	const piEntry = paths["@earendil-works/pi-coding-agent"][0];
	const piRoot = path.dirname(path.dirname(piEntry));
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
	const toolExecutionPrototype = codingAgent.ToolExecutionComponent.prototype;
	const originalRender = toolExecutionPrototype.render;
	const originalHandleMouse = toolExecutionPrototype.handleMouse;
	// Pi asks the most recently loaded extension's tool-renderer resolver how a
	// call is drawn; `next()` yields the call's own definition.
	let toolRenderer;
	const registerToolRenderer = (resolver) => { toolRenderer = resolver; };
	const renderersFor = (instance) => toolRenderer(instance.toolName, () => instance.toolDefinition);
	const shellOf = (instance) => renderersFor(instance)?.renderShell ?? "default";

	const configModule = await jiti.import(path.resolve("pi-tool-output/config.ts"));
	const normalized = configModule.normalizeToolOutputConfig({
		previewLines: 500,
		expandedPreviewMaxLines: -10,
		bashCollapsedLines: 4.8,
		readOutputMode: "invalid",
		tools: {
			bash: false,
			ide_find_symbol: { outputMode: "preview" },
			custom_mcp: true,
			native_tool: { expanded: "native", outputMode: "sideways" },
			"  ": false,
			broken: 3,
		},
	});
	assert.equal(normalized.previewLines, 80);
	assert.equal(normalized.expandedPreviewMaxLines, 0);
	assert.equal(normalized.bashCollapsedLines, 4);
	assert.equal(normalized.readOutputMode, "preview");
	assert.deepEqual(normalized.tools, {
		bash: false,
		ide_find_symbol: { outputMode: "preview" },
		custom_mcp: {},
		native_tool: { expanded: "native" },
	});
	assert.equal(configModule.drawsTool(normalized, "read"), true);
	assert.equal(configModule.drawsTool(normalized, "bash"), false);
	assert.equal(
		configModule.saveToolOutputConfig({
			...configModule.DEFAULT_TOOL_OUTPUT_CONFIG,
			expandedPreviewMaxLines: 2,
			tools: {
				late_generic: { outputMode: "summary" },
				mcp_passthrough: false,
				native_result: { expanded: "native" },
			},
		}).success,
		true,
	);

	const factory = await jiti.import(path.resolve("pi-tool-output/index.ts"), { default: true });
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = new Map();
	const pi = {
		registerShortcut(key, shortcut) {
			shortcuts.set(key, shortcut);
		},
		registerToolRenderer,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};

	factory(pi);
	assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	assert.ok(commands.has("tool-output"));
	for (const tool of tools.values()) assert.equal(tool.renderShell, "self");

	const theme = {
		fg(_color, text) {
			return text;
		},
		bg(_color, text) {
			return text;
		},
		bold(text) {
			return text;
		},
		getBgAnsi() {
			return "";
		},
	};
	const toolBox = await jiti.import(path.resolve("pi-tool-output/tool-box.ts"));
	let innerRenders = 0;
	let innerInvalidations = 0;
	let innerRows = Array.from({ length: 4_000 }, (_value, index) => `cached line ${index}`);
	const cachedResult = toolBox.toolResultBox(
		{
			render() {
				innerRenders++;
				return innerRows;
			},
			invalidate() {
				innerInvalidations++;
			},
		},
		theme,
		{ state: {} },
	);
	const firstCachedRows = cachedResult.render(100);
	assert.equal(cachedResult.render(100), firstCachedRows);
	assert.equal(innerRenders, 2);
	innerRows = ["updated line"];
	const updatedRows = cachedResult.render(100);
	assert.notEqual(updatedRows, firstCachedRows);
	assert.match(updatedRows[0], /updated line/);
	assert.equal(innerRenders, 3);
	const resizedRows = cachedResult.render(80);
	assert.notEqual(resizedRows, updatedRows);
	assert.equal(innerRenders, 4);
	cachedResult.invalidate();
	assert.equal(innerInvalidations, 1);
	assert.notEqual(cachedResult.render(80), resizedRows);
	assert.equal(innerRenders, 5);

	const joinedBoxContext = { state: {} };
	let callRenders = 0;
	const cachedCall = toolBox.toolCallBox(
		"Cache Test",
		{
			render() {
				callRenders++;
				return ["arguments"];
			},
			invalidate() {},
		},
		theme,
		joinedBoxContext,
	);
	assert.match(cachedCall.render(100).at(-1), /╰─+╯/);
	toolBox.toolResultBox({ render: () => ["result"], invalidate() {} }, theme, joinedBoxContext);
	assert.doesNotMatch(cachedCall.render(100).at(-1), /╰─+╯/);
	assert.equal(callRenders, 2);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler(
			{ type: "session_start" },
			{ mode: "tui", ui: { theme, notify() {} } },
		);
	}
	assert.notEqual(toolExecutionPrototype.render, originalRender);
	assert.notEqual(toolExecutionPrototype.handleMouse, originalHandleMouse);

	const adapterCallRenderer = () => ({ render: () => ["adapter call"] });
	const adapterResultRenderer = () => ({ render: () => ["adapter result"] });
	const lateMcpDefinition = {
		name: "mcp",
		label: "MCP",
		description: "MCP gateway",
		renderCall: adapterCallRenderer,
		renderResult: adapterResultRenderer,
		renderShell: "default",
	};
	const lateMcpInstance = { toolName: "mcp", toolDefinition: lateMcpDefinition };
	const runtimeMcpCall = renderersFor(lateMcpInstance)?.renderCall;
	const runtimeMcpResult = renderersFor(lateMcpInstance)?.renderResult;
	assert.notEqual(runtimeMcpCall, adapterCallRenderer);
	assert.notEqual(runtimeMcpResult, adapterResultRenderer);
	assert.equal(shellOf(lateMcpInstance), "self");
	const runtimeMcpContext = { args: { server: "linear" }, isError: false, state: {} };
	const runtimeMcpCallComponent = runtimeMcpCall({ server: "linear" }, theme, runtimeMcpContext);
	assert.match(runtimeMcpCallComponent.render(100)[0], /\uf0ad MCP Gateway/);
	assert.match(runtimeMcpCallComponent.render(100)[1], /server: linear/);
	const unsafeArgsCall = runtimeMcpCall(
		{ server: "safe\x1b]52;c;Y2xpcGJvYXJk\x07text\x1b[2J" },
		theme,
		{ args: {}, isError: false, state: {} },
	).render(100).join("\n");
	assert.match(unsafeArgsCall, /server: safetext/);
	assert.doesNotMatch(unsafeArgsCall, /\x1b\]52|\x1b\[2J|Y2xpcGJvYXJk/);
	for (const expanded of [false, true]) {
		const resultLines = runtimeMcpResult(
			{ content: [{ type: "text", text: "late adapter payload" }], details: {} },
			{ expanded, isPartial: false },
			theme,
			runtimeMcpContext,
		).render(100);
		assert.match(resultLines[0], /late adapter payload/);
		assert.match(resultLines.at(-1), /╰─+╯/);
	}
	const mergedCallLines = runtimeMcpCallComponent.render(100);
	assert.equal(mergedCallLines.length, 2);
	assert.doesNotMatch(mergedCallLines.at(-1), /╰─+╯/);
	const errorLines = runtimeMcpResult(
		{ content: [{ type: "text", text: "MCP failed" }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
		{ args: {}, isError: true, state: {} },
	).render(100);
	assert.match(errorLines[0], /MCP failed/);
	assert.match(errorLines.at(-1), /╰─+╯/);
	// Every tool is drawn here, whatever renderer it brings, unless its `tools` entry is false.
	const ordinaryCallRenderer = () => ({ render: () => ["ordinary"] });
	const ordinaryResultRenderer = () => ({ render: () => ["ordinary result"] });
	const ordinaryInstance = {
		toolName: "ordinary_tool",
		toolDefinition: { name: "ordinary_tool", label: "Ordinary", renderCall: ordinaryCallRenderer, renderShell: "default" },
	};
	assert.notEqual(renderersFor(ordinaryInstance)?.renderCall, ordinaryCallRenderer);
	assert.equal(shellOf(ordinaryInstance), "self");
	const plainInstance = { toolName: "trajectory_search", toolDefinition: { name: "trajectory_search", label: "Trajectory Search" } };
	assert.equal(typeof renderersFor(plainInstance)?.renderCall, "function");
	assert.equal(shellOf(plainInstance), "self");
	const goneInstance = { toolName: "removed_tool", toolDefinition: undefined };
	assert.equal(typeof renderersFor(goneInstance)?.renderCall, "function", "a call to a tool that is gone is still drawn");
	const optedOutInstance = {
		toolName: "mcp_passthrough",
		toolDefinition: {
			name: "mcp_passthrough",
			label: "MCP passthrough",
			renderCall: ordinaryCallRenderer,
			renderResult: ordinaryResultRenderer,
			renderShell: "default",
		},
	};
	assert.equal(renderersFor(optedOutInstance)?.renderCall, ordinaryCallRenderer);
	assert.equal(renderersFor(optedOutInstance)?.renderResult, ordinaryResultRenderer);
	assert.equal(shellOf(optedOutInstance), "default");
	// `expanded: "native"` keeps the house row but the tool's own result view, unless that draws nothing.
	let nativeDraws = true;
	const nativeInstance = {
		toolName: "native_result",
		toolDefinition: {
			name: "native_result",
			renderCall: ordinaryCallRenderer,
			renderResult: () => (nativeDraws ? ordinaryResultRenderer() : undefined),
		},
	};
	assert.notEqual(renderersFor(nativeInstance)?.renderCall, ordinaryCallRenderer);
	const nativeResult = renderersFor(nativeInstance)?.renderResult;
	const nativeArgs = [{ content: [{ type: "text", text: "house payload" }] }, { expanded: true, isPartial: false }, theme, { args: {}, state: {} }];
	assert.deepEqual(nativeResult(...nativeArgs).render(100), ["ordinary result"]);
	nativeDraws = false;
	assert.match(nativeResult(...nativeArgs).render(100).join("\n"), /house payload/);

	const context = {
		args: {},
		toolCallId: "test",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
	const options = { expanded: false, isPartial: false };

	// Use Pi's real definition and sandbox: variable-driven calls cannot be
	// reconstructed from the source, and partial results contain only metadata.
	const nativeCodemode = await jiti.import(path.join(piRoot, "dist/extensions/codemode/tool.js"));
	const codemodeDefinition = nativeCodemode.createCodemodeToolDefinition();
	const originalCodemodeExecute = codemodeDefinition.execute;
	const codemodeInstance = { toolName: "codemode", toolDefinition: codemodeDefinition };
	const runtimeCodemodeResult = renderersFor(codemodeInstance)?.renderResult;
	assert.notEqual(renderersFor(codemodeInstance)?.renderCall, codemodeDefinition.renderCall);
	assert.notEqual(runtimeCodemodeResult, codemodeDefinition.renderResult);
	assert.equal(shellOf(codemodeInstance), "self");
	const codemodeArgs = { code: 'const files = ["one.ts", "missing.ts"]; const results = await Promise.allSettled(files.map(path => tools.read({ path }))); text(results.map(r => r.status));' };
	const codemodeComponent = new codingAgent.ToolExecutionComponent(
		"codemode", "code-call", codemodeArgs, { showImages: false }, renderersFor(codemodeInstance),
		{ requestRender() {} }, process.cwd(),
	);
	codemodeComponent.setArgsComplete();
	codemodeComponent.markExecutionStarted();
	const updates = [];
	let nestedId = 0;
	const codemodeResult = await codemodeDefinition.execute(
		"code-call", codemodeArgs, AbortSignal.timeout(10_000),
		(update) => {
			updates.push(update);
			codemodeComponent.updateResult({ ...update, isError: false }, true);
		},
		{
			tools: [{ name: "read", description: "Fixture reader", parameters: tools.get("read").parameters }],
			sessionManager: { getBranch: () => [] },
			async executeTool(name, args) {
				return {
					toolCall: { id: `code-call/${++nestedId}`, name, arguments: args },
					isError: args.path === "missing.ts",
					result: { content: [{ type: "text", text: args.path === "missing.ts" ? "NESTED_FAILURE" : "fixture text" }] },
				};
			},
		},
	);
	assert.equal(codemodeDefinition.execute, originalCodemodeExecute);
	assert.ok(updates.some((update) => update.details.calls.some((call) => call.status === "running")));
	assert.equal(codemodeResult.isError, undefined); // allSettled handles the failed nested call.
	const savedCodemodeResult = structuredClone(codemodeResult);
	// Its first update comes before any call starts and lists none.
	for (const update of updates.filter((update) => update.details.calls.length > 0)) {
		const partial = runtimeCodemodeResult(update, { ...options, isPartial: true }, theme, { ...context, state: {} }).render(100).join("\n");
		assert.match(partial, /Read File/);
	}
	codemodeComponent.updateResult({ ...codemodeResult, isError: false });
	let codemodeScreen = piTui.stripTerminalSequences(codemodeComponent.render(100).join("\n"));
	// Collapsed, a call is one row: name, summary, sizes — no nested calls or output.
	assert.match(codemodeScreen, /Code Mode  JavaScript/);
	assert.doesNotMatch(codemodeScreen, /Read File|NESTED_FAILURE|files.map|Wall time|Output:/);
	codemodeComponent.setExpanded(true);
	codemodeScreen = piTui.stripTerminalSequences(codemodeComponent.render(100).join("\n"));
	assert.match(codemodeScreen, /files.map/, "expanded shows the script");
	assert.match(codemodeScreen, /✓ Read File · \d+ms\s*│\n│\s+path: one\.ts/);
	assert.match(codemodeScreen, /✗ Read File · \d+ms\s*│\n│\s+path: missing\.ts/);
	assert.match(codemodeScreen, /NESTED_FAILURE/);
	assert.match(codemodeScreen, /Script completed ·/);
	codemodeComponent.setExpanded(false);
	assert.doesNotMatch(piTui.stripTerminalSequences(codemodeComponent.render(100).join("\n")), /files.map/);
	assert.deepEqual(codemodeResult, savedCodemodeResult);
	for (const expanded of [false, true]) {
		const truncated = runtimeCodemodeResult(
			{ content: [{ type: "text", text: "one\ntwo\nthree\nScript error: late failure" }],
				details: { calls: [], fullOutputPath: "/tmp/codemode-full-output" }, isError: true },
			{ expanded, isPartial: false }, theme, { ...context, state: {}, isError: true },
		).render(100).join("\n");
		assert.match(truncated, /full output: \/tmp\/codemode-full-output/);
	}

	// Every owned call route gets the same physical-row limits and expansion state.
	const largeScript = "console.log('ARGUMENT_BODY_MARKER');\n".repeat(1000);
	const argumentFixtures = [
		["bash", { command: `python3 - <<'PY'\n${largeScript}PY` }],
		["read", { path: "file/".repeat(1000), offset: 1, limit: 20 }],
		["grep", { pattern: "pattern".repeat(1000), path: "." }],
		["find", { pattern: "*".repeat(1000) }],
		["ls", { path: "dir/".repeat(1000) }],
		["subagent", { workflowScript: largeScript, async: true }],
		["codemode", { code: largeScript }],
		["mcp", { tool: "search", args: { nested: Array(1000).fill({ data: largeScript }) } }],
		["late_generic", { text: largeScript, items: Array(10_000).fill("value") }],
		["web_search", { query: "界🙂".repeat(1000) }],
	];
	for (const [name, args] of argumentFixtures) {
		const renderer = tools.get(name)?.renderCall ?? renderersFor({ toolName: name, toolDefinition: { name } })?.renderCall;
		for (const expanded of [false, true]) {
			const component = renderer(args, theme, { ...context, args, state: {}, expanded });
			for (const width of [1, 2, 8, 12, 22, 26, 40, 60, 100, 200]) {
				const rows = component.render(width);
				assert.ok(rows.length <= (expanded ? 124 : 7), `${name}: ${rows.length} rows at ${width}`);
				for (const row of rows) assert.ok(piTui.visibleWidth(row) <= width, `${name}: over-wide row at ${width}`);
				if (!expanded) assert.doesNotMatch(rows.join("\n"), /ARGUMENT_BODY_MARKER/);
			}
		}
	}
	const tones = [];
	const coloredTheme = { ...theme, fg(color, text) { tones.push([color, text]); return text; } };
	tools.get("bash").renderCall({ command: "npm run check" }, coloredTheme, { ...context, state: {} }).render(100);
	assert.ok(tones.some(([color, text]) => color === "success" && text === "npm run check"));
	tones.length = 0;
	tools.get("read").renderCall({ path: "file.ts" }, coloredTheme, { ...context, state: {} }).render(100);
	assert.ok(tones.some(([color, text]) => color === "success" && text === "path"));
	assert.ok(tones.some(([color, text]) => color === "accent" && text === "file.ts"));
	tones.length = 0;
	tools.get("read").renderCall({ path: "file.ts", offset: "not-a-number" }, coloredTheme, { ...context, state: {} }).render(100);
	assert.ok(tones.some(([color, text]) => color === "accent" && text === "offset"));
	assert.ok(tones.some(([color, text]) => color === "accent" && text === "not-a-number"));
	assert.ok(tones.some(([color]) => color === "success")); // Frame and summary keys stay green.

	// An expanded multi-line value keeps the call's tone on every line, so a
	// script body is never rendered in the dimmed tone used for results.
	tones.length = 0;
	const scriptBody = "import os\nprint('hello')\n    indented";
	tools
		.get("bash")
		.renderCall({ command: scriptBody }, coloredTheme, { ...context, state: {}, expanded: true })
		.render(100);
	for (const line of ["print('hello')", "    indented"]) {
		const painted = tones.filter(([, text]) => text === line);
		assert.ok(painted.length > 0, `expanded body line not rendered: ${line}`);
		assert.ok(
			painted.every(([color]) => color === "accent"),
			`expanded body line ${JSON.stringify(line)} used ${painted.map(([color]) => color).join("/")}`,
		);
	}
	assert.ok(!tones.some(([color, text]) => color === "muted" && text.includes("print('hello')")));
	// Numeric-looking body lines are not mistaken for descriptor measures.
	assert.ok(!tones.some(([color]) => color === "syntaxNumber"));

	const actualTool = new codingAgent.ToolExecutionComponent(
		"subagent", "large-call", { workflowScript: largeScript, async: true },
		{ showImages: false }, renderersFor({ toolName: "subagent", toolDefinition: { name: "subagent" } }),
		{ requestRender() {} }, process.cwd(),
	);
	actualTool.setArgsComplete();
	actualTool.markExecutionStarted();
	let screen = piTui.stripTerminalSequences(actualTool.render(100).join("\n"));
	assert.match(screen, /Scripted workflow/);
	assert.doesNotMatch(screen, /ARGUMENT_BODY_MARKER/);
	// Expansion works even while the call is pending, before a result exists.
	actualTool.setExpanded(true);
	screen = piTui.stripTerminalSequences(actualTool.render(100).join("\n"));
	assert.match(screen, /ARGUMENT_BODY_MARKER/);
	assert.match(screen, /arguments capped/);
	actualTool.updateResult({ content: [{ type: "text", text: "RESULT_STAYS_VISIBLE" }], details: {} });
	screen = piTui.stripTerminalSequences(actualTool.render(100).join("\n"));
	assert.match(screen, /RESULT_STAYS_VISIBLE/, "expanded shows the output");
	actualTool.setExpanded(false);
	screen = piTui.stripTerminalSequences(actualTool.render(100).join("\n"));
	// Collapsed, the output is measured, not shown.
	assert.match(screen, /1 line, 20 B/);
	assert.doesNotMatch(screen, /RESULT_STAYS_VISIBLE|ARGUMENT_BODY_MARKER/);
	assert.ok(screen.split("\n").length < 6);
	actualTool.updateArgs({ agent: "reviewer", task: "Inspect this module" });
	screen = piTui.stripTerminalSequences(actualTool.render(100).join("\n"));
	assert.match(screen, /agent: reviewer/);
	assert.doesNotMatch(screen, /Scripted workflow/);

	const readResult = tools.get("read").renderResult(
		{ content: [{ type: "text", text: "secret output" }], details: {} },
		options,
		theme,
		context,
	);
	const readLines = readResult.render(100);
	assert.match(readLines[0], /secret output/);
	assert.match(readLines.at(-1), /╰─+╯/);

	// ToolExecutionComponent owns image rendering independently of custom text
	// renderers, so self-rendered house boxes must still leave image blocks intact.
	const originalCapabilities = piTui.getCapabilities();
	piTui.setCapabilities({ ...originalCapabilities, images: "iterm2" });
	try {
		const imageReadComponent = new codingAgent.ToolExecutionComponent(
			"read",
			"image-read",
			{ path: "pixel.png" },
			{ showImages: true },
			tools.get("read"),
			{ requestRender() {} },
			process.cwd(),
		);
		imageReadComponent.setArgsComplete();
		imageReadComponent.markExecutionStarted();
		imageReadComponent.updateResult({
			content: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
				},
			],
			details: {},
		});
		assert.equal(imageReadComponent.imageComponents.length, 1);
		// Collapsed, an image is counted, not drawn; expanding draws it.
		assert.doesNotMatch(imageReadComponent.render(100).join("\n"), /1337;File=/);
		assert.match(piTui.stripTerminalSequences(imageReadComponent.render(100).join("\n")), /Read File\s+path: pixel\.png  1 image/);
		imageReadComponent.setExpanded(true);
		assert.match(imageReadComponent.render(100).join("\n"), /1337;File=/);
		const imageCodemodeComponent = new codingAgent.ToolExecutionComponent(
			"codemode", "image-code", { code: "image(pixel)" }, { showImages: true }, renderersFor(codemodeInstance),
			{ requestRender() {} }, process.cwd(),
		);
		imageCodemodeComponent.setArgsComplete();
		imageCodemodeComponent.markExecutionStarted();
		imageCodemodeComponent.updateResult({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, ...imageReadComponent.result.content],
			details: { calls: [] }, isError: false,
		});
		assert.equal(imageCodemodeComponent.imageComponents.length, 1);
		imageCodemodeComponent.setExpanded(true);
		assert.match(imageCodemodeComponent.render(100).join("\n"), /1337;File=/);
	} finally {
		piTui.setCapabilities(originalCapabilities);
	}

	const bashOutput = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\n");
	const bashResult = tools.get("bash").renderResult(
		{ content: [{ type: "text", text: bashOutput }], details: {} },
		options,
		theme,
		context,
	);
	const bashLines = bashResult.render(100);
	assert.equal(bashLines.length, 12);
	assert.match(bashLines.at(-2), /2 more lines/);
	assert.match(bashLines.at(-1), /╰─+╯/);

	const truncatedBash = tools.get("bash").renderResult(
		{
			content: [{ type: "text", text: "retained 1\nretained 2" }],
			details: {
				truncation: { truncated: true, totalLines: 100, outputLines: 2, truncatedBy: "lines" },
				fullOutputPath: "/tmp/pi-bash-full.log",
			},
		},
		options,
		theme,
		context,
	);
	assert.match(truncatedBash.render(100).at(-2), /output truncated \(100 total lines\).*pi-bash-full\.log/);
	const expandedTruncatedBash = tools.get("bash").renderResult(
		{
			content: [{ type: "text", text: "retained 1\nretained 2" }],
			details: {
				truncation: { truncated: true, totalLines: 100, outputLines: 2, truncatedBy: "lines" },
				fullOutputPath: "/tmp/pi-bash-full.log",
			},
		},
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	assert.match(expandedTruncatedBash.render(100).at(-2), /output truncated \(100 total lines\).*pi-bash-full\.log/);
	for (const expanded of [false, true]) {
		const erroredTruncatedBash = tools.get("bash").renderResult(
			{
				content: [{ type: "text", text: "failure output" }],
				details: {
					truncation: { truncated: true, totalLines: 100, outputLines: 1, truncatedBy: "lines" },
					fullOutputPath: "/tmp/pi-bash-error-full.log",
				},
			},
			{ expanded, isPartial: false },
			theme,
			{ ...context, isError: true },
		);
		assert.match(
			erroredTruncatedBash.render(100).at(-2),
			/output truncated \(100 total lines\).*pi-bash-error-full\.log/,
		);
	}
	const cappedExpandedBash = tools.get("bash").renderResult(
		{ content: [{ type: "text", text: "line 1\nline 2\nline 3" }], details: {} },
		{ expanded: true, isPartial: false },
		theme,
		context,
	);
	const cappedExpandedLines = cappedExpandedBash.render(100).join("\n");
	assert.match(cappedExpandedLines, /display capped at 2 lines/);
	assert.doesNotMatch(cappedExpandedLines, /to expand/);

	const visibleError = tools.get("read").renderResult(
		{ content: [{ type: "text", text: "permission denied" }], details: {} },
		options,
		theme,
		{ ...context, isError: true },
	);
	const visibleErrorLines = visibleError.render(100);
	assert.match(visibleErrorLines[0], /permission denied/);
	assert.match(visibleErrorLines.at(-1), /╰─+╯/);

	const projectDir = path.join(testAgentDir, "project");
	mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	writeFileSync(
		path.join(projectDir, ".pi", "settings.json"),
		JSON.stringify({ shellCommandPrefix: "export PI_TOOL_OUTPUT_PROJECT_PREFIX=trusted" }),
	);
	const executionContext = {
		cwd: projectDir,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "tool-output-session",
			getSessionFile: () => "/tmp/tool-output-session.jsonl",
		},
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
	};
	const execution = await tools.get("bash").execute(
		"execution-test",
		{
			command:
				"printf '%s' \"$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_TOOL_OUTPUT_PROJECT_PREFIX\"",
		},
		undefined,
		undefined,
		executionContext,
	);
	const executionText = execution.content.find((block) => block.type === "text")?.text;
	assert.equal(
		executionText,
		"tool-output-session|/tmp/tool-output-session.jsonl|test-provider|test-model|high|trusted",
	);
	const untrustedExecution = await tools.get("bash").execute(
		"untrusted-settings-test",
		{ command: "printf '<%s>' \"$PI_TOOL_OUTPUT_PROJECT_PREFIX\"" },
		undefined,
		undefined,
		{ ...executionContext, isProjectTrusted: () => false },
	);
	assert.equal(untrustedExecution.content.find((block) => block.type === "text")?.text, "<>");
	assert.equal(typeof tools.get("bash").promptSnippet, "string");

	// A write records what it replaced; an edit passes pi's own diff through.
	const write = (id, content) => tools.get("write").execute(id, { path: "notes.md", content }, undefined, undefined, executionContext);
	const created = await write("write-create", "one\ntwo\n");
	assert.deepEqual(created.details, { created: true });
	assert.equal(readFileSync(path.join(projectDir, "notes.md"), "utf8"), "one\ntwo\n");
	const overwrote = await write("write-overwrite", "one\nTWO\n");
	assert.equal(overwrote.details.created, false);
	assert.match(overwrote.details.diff, /^-2 two\n\+2 TWO$/m);
	assert.match(overwrote.content[0].text, /Successfully wrote/, "the model still sees pi's own result");
	const edited = await tools.get("edit").execute(
		"edit-test",
		{ path: "notes.md", edits: [{ oldText: "TWO", newText: "2" }] },
		undefined,
		undefined,
		executionContext,
	);
	assert.match(edited.details.diff, /^-2 TWO\n\+2 2$/m);
	assert.ok(Array.isArray(tools.get("bash").promptGuidelines));

	// A tool with no renderers of its own gets the house call view, with large arguments measured.
	const unknownCall = renderersFor({ toolName: "unknown_tool", toolDefinition: { name: "unknown_tool" } })?.renderCall;
	const unknownArgs = { prompt: largeScript, data: { payload: largeScript } };
	const compactUnknown = unknownCall(unknownArgs, theme, { ...context, state: {} }).render(100).join("\n");
	assert.match(compactUnknown, /prompt: [\d.]+ KB/);
	assert.doesNotMatch(compactUnknown, /ARGUMENT_BODY_MARKER/);
	const expandedUnknown = unknownCall(unknownArgs, theme, { ...context, state: {}, expanded: true }).render(100).join("\n");
	assert.match(expandedUnknown, /ARGUMENT_BODY_MARKER/);
	assert.match(expandedUnknown, /arguments capped/);

	let reloads = 0;
	await commands.get("tool-output").handler("off", {
		ui: { notify() {} },
		async reload() {
			reloads++;
		},
	});
	assert.equal(reloads, 1);
	assert.equal(configModule.loadToolOutputConfig().config.enabled, false);

	// Simulate an extension loaded after pi-tool-output composing one method.
	// Shutdown must restore the other method and leave the retained wrapper inert.
	const installedRender = toolExecutionPrototype.render;
	const composedRender = function (width) {
		return installedRender.call(this, width);
	};
	toolExecutionPrototype.render = composedRender;

	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, {});
	}
	assert.equal(toolExecutionPrototype.render, composedRender);
	assert.equal(toolExecutionPrototype.handleMouse, originalHandleMouse);
	assert.equal(renderersFor(lateMcpInstance).renderCall, adapterCallRenderer, "a shut-down session draws calls with their own renderers");

	const optInConfig = {
		...configModule.DEFAULT_TOOL_OUTPUT_CONFIG,
		tools: { codemode: false },
	};
	assert.equal(configModule.saveToolOutputConfig(optInConfig).success, true);
	const optInTools = new Map();
	const optInHandlers = new Map();
	factory({
		registerTool(tool) {
			optInTools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerToolRenderer,
		on(name, handler) {
			const list = optInHandlers.get(name) ?? [];
			list.push(handler);
			optInHandlers.set(name, list);
		},
	});
	for (const handler of optInHandlers.get("session_start") ?? []) {
		await handler(
			{ type: "session_start" },
			{ mode: "tui", ui: { theme, notify() {} } },
		);
	}
	assert.notEqual(toolExecutionPrototype.render, composedRender);
	assert.equal(renderersFor(codemodeInstance)?.renderCall, codemodeDefinition.renderCall);
	assert.equal(renderersFor(codemodeInstance)?.renderResult, codemodeDefinition.renderResult);
	assert.equal(shellOf(codemodeInstance), "default");
	assert.deepEqual([...optInTools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	assert.equal(typeof optInTools.get("edit").renderCall, "function");
	assert.equal(typeof optInTools.get("edit").renderResult, "function");
	assert.equal(typeof optInTools.get("write").renderCall, "function");
	assert.equal(typeof optInTools.get("write").renderResult, "function");
	for (const handler of optInHandlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, {});
	}
	assert.equal(toolExecutionPrototype.render, composedRender);
	assert.equal(toolExecutionPrototype.handleMouse, originalHandleMouse);
	assert.equal(renderersFor(lateMcpInstance).renderCall, adapterCallRenderer, "a shut-down session draws calls with their own renderers");
	// Codemode is not governed by MCP output settings, but its own `tools`
	// output mode applies. Error output survives an explicit hidden mode.
	for (const mode of [undefined, "summary", "hidden"]) {
		configModule.saveToolOutputConfig({
			...configModule.DEFAULT_TOOL_OUTPUT_CONFIG,
			mcpOutputMode: "hidden",
			tools: mode ? { codemode: { outputMode: mode } } : {},
		});
		const modeHandlers = new Map();
		factory({
			registerTool() {}, registerCommand() {}, registerShortcut() {}, registerToolRenderer,
			on(name, handler) { modeHandlers.set(name, handler); },
		});
		await modeHandlers.get("session_start")({ type: "session_start" }, { mode: "tui", ui: { theme, notify() {} } });
		const renderer = renderersFor(codemodeInstance)?.renderResult;
		const output = renderer(codemodeResult, options, theme, { ...context, state: {} }).render(100).join("\n");
		if (mode === "hidden") {
			assert.doesNotMatch(output, /Read File|Script completed|fulfilled/);
			const failed = renderer({ content: [{ type: "text", text: "Script failed" }] }, options, theme, { ...context, state: {}, isError: true }).render(100).join("\n");
			assert.match(failed, /Script failed/);
		} else {
			assert.match(output, /Read File/);
			assert.match(output, mode === "summary" ? /lines returned/ : /fulfilled/);
		}
		await modeHandlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
	}
	// Configured colors reach the renderers; invalid ones are reported.
	configModule.saveToolOutputConfig({ ...configModule.DEFAULT_TOOL_OUTPUT_CONFIG, colors: { call: { summaryValue: "warning" } } });
	const stored = JSON.parse(readFileSync(path.join(testAgentDir, "pi-tool-output", "config.json"), "utf8"));
	writeFileSync(path.join(testAgentDir, "pi-tool-output", "config.json"), JSON.stringify({ ...stored, colors: { ...stored.colors, box: { frame: "nope" } } }));
	const colorTools = new Map();
	const colorHandlers = new Map();
	factory({
		registerTool(tool) { colorTools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerToolRenderer,
		on(name, handler) { colorHandlers.set(name, handler); },
	});
	const notices = [];
	await colorHandlers.get("session_start")({ type: "session_start" }, { mode: "tui", ui: { theme, notify: (message) => notices.push(message) } });
	assert.match(notices.join("\n"), /"colors\.box\.frame" must be a theme color name/);
	tones.length = 0;
	colorTools.get("read").renderCall({ path: "file.ts" }, coloredTheme, { ...context, state: {} }).render(100);
	assert.ok(tones.some(([color, text]) => color === "warning" && text === "file.ts"));
	await colorHandlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, {});
	toolExecutionPrototype.render = originalRender;
	console.log("tool-output integration fixture passed");
})()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(testAgentDir, { force: true, recursive: true });
	});
