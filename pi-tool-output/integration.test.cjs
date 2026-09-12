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
	const originalGetCallRenderer = toolExecutionPrototype.getCallRenderer;
	const originalGetResultRenderer = toolExecutionPrototype.getResultRenderer;
	const originalGetRenderShell = toolExecutionPrototype.getRenderShell;

	const configModule = await jiti.import(path.resolve("pi-tool-output/config.ts"));
	const normalized = configModule.normalizeToolOutputConfig({
		previewLines: 500,
		expandedPreviewMaxLines: -10,
		bashCollapsedLines: 4.8,
		readOutputMode: "invalid",
		registerToolOverrides: { bash: false },
		customToolOverrides: {
			ide_find_symbol: { enabled: true, kind: "generic", outputMode: "preview" },
			custom_mcp: true,
			read: { enabled: true, kind: "mcp", outputMode: "preview" },
		},
	});
	assert.equal(normalized.previewLines, 80);
	assert.equal(normalized.expandedPreviewMaxLines, 0);
	assert.equal(normalized.bashCollapsedLines, 4);
	assert.equal(normalized.readOutputMode, "preview");
	assert.equal(normalized.registerToolOverrides.read, true);
	assert.equal(normalized.registerToolOverrides.bash, false);
	assert.deepEqual(normalized.customToolOverrides.ide_find_symbol, {
		enabled: true,
		kind: "generic",
		outputMode: "preview",
	});
	assert.deepEqual(normalized.customToolOverrides.custom_mcp, {
		enabled: true,
		kind: "generic",
		outputMode: "summary",
	});
	assert.equal(normalized.customToolOverrides.read, undefined);
	assert.equal(
		configModule.saveToolOutputConfig({
			...configModule.DEFAULT_TOOL_OUTPUT_CONFIG,
			expandedPreviewMaxLines: 2,
			customToolOverrides: {
				late_generic: { enabled: true, kind: "generic", outputMode: "summary" },
				mcp_passthrough: { enabled: false, kind: "mcp", outputMode: "hidden" },
			},
		}).success,
		true,
	);

	const decorator = await jiti.import(path.resolve("pi-tool-output/decorate.ts"));
	const earlyMcp = {
		name: "early_mcp",
		label: "Early MCP",
		description: "MCP tool registered before the renderer",
		parameters: {},
		execute: async () => ({ content: [] }),
	};
	assert.equal(decorator.decorateMcpToolOutput(earlyMcp), earlyMcp);
	assert.equal(decorator.decorateMcpToolOutput(earlyMcp), earlyMcp);
	assert.equal(earlyMcp.renderResult, undefined);

	const factory = await jiti.import(path.resolve("pi-tool-output/index.ts"), { default: true });
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const pi = {
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
	assert.deepEqual([...tools.keys()].sort(), ["bash", "find", "grep", "ls", "read"]);
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
	for (const handler of handlers.get("session_start") ?? []) {
		await handler(
			{ type: "session_start" },
			{ mode: "tui", ui: { theme, notify() {} } },
		);
	}
	assert.notEqual(toolExecutionPrototype.getCallRenderer, originalGetCallRenderer);
	assert.notEqual(toolExecutionPrototype.getResultRenderer, originalGetResultRenderer);
	assert.notEqual(toolExecutionPrototype.getRenderShell, originalGetRenderShell);

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
	const runtimeMcpCall = toolExecutionPrototype.getCallRenderer.call(lateMcpInstance);
	const runtimeMcpResult = toolExecutionPrototype.getResultRenderer.call(lateMcpInstance);
	assert.notEqual(runtimeMcpCall, adapterCallRenderer);
	assert.notEqual(runtimeMcpResult, adapterResultRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell.call(lateMcpInstance), "self");
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
	const ordinaryCallRenderer = () => ({ render: () => ["ordinary"] });
	const ordinaryInstance = {
		toolName: "ordinary_tool",
		toolDefinition: { name: "ordinary_tool", label: "Ordinary", renderCall: ordinaryCallRenderer },
	};
	assert.equal(toolExecutionPrototype.getCallRenderer.call(ordinaryInstance), ordinaryCallRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell.call(ordinaryInstance), "default");
	const configuredGenericInstance = {
		toolName: "late_generic",
		toolDefinition: { name: "late_generic", label: "Late generic", renderCall: ordinaryCallRenderer },
	};
	assert.notEqual(toolExecutionPrototype.getCallRenderer.call(configuredGenericInstance), ordinaryCallRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell.call(configuredGenericInstance), "self");
	const knownCustomInstance = {
		toolName: "web_search",
		toolDefinition: { name: "web_search", label: "web_search", renderCall: ordinaryCallRenderer },
	};
	assert.notEqual(toolExecutionPrototype.getCallRenderer.call(knownCustomInstance), ordinaryCallRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell.call(knownCustomInstance), "self");
	const optedOutMcpInstance = {
		toolName: "mcp_passthrough",
		toolDefinition: {
			name: "mcp_passthrough",
			label: "MCP passthrough",
			renderCall: ordinaryCallRenderer,
			renderShell: "default",
		},
	};
	assert.equal(toolExecutionPrototype.getCallRenderer.call(optedOutMcpInstance), ordinaryCallRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell.call(optedOutMcpInstance), "default");

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
		assert.match(imageReadComponent.render(100).join("\n"), /1337;File=/);
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
	assert.ok(Array.isArray(tools.get("bash").promptGuidelines));

	const apiKey = Symbol.for("pi-tool-output.api.v1");
	const api = globalThis[apiKey];
	assert.equal(api.version, 1);
	const partialCallTool = {
		name: "partial_call_tool",
		renderCall: ordinaryCallRenderer,
		renderShell: "default",
	};
	assert.equal(api.decorateTool(partialCallTool), partialCallTool);
	assert.equal(partialCallTool.renderCall, ordinaryCallRenderer);
	assert.equal(partialCallTool.renderResult, undefined);
	assert.equal(partialCallTool.renderShell, "default");
	const ordinaryResultRenderer = () => ({ render: () => ["ordinary result"] });
	const partialResultTool = { name: "partial_result_tool", renderResult: ordinaryResultRenderer };
	assert.equal(api.decorateTool(partialResultTool), partialResultTool);
	assert.equal(partialResultTool.renderCall, undefined);
	assert.equal(partialResultTool.renderResult, ordinaryResultRenderer);
	assert.equal(partialResultTool.renderShell, undefined);
	assert.equal(typeof earlyMcp.renderResult, "function");
	const earlyMcpResult = earlyMcp.renderResult(
		{ content: [{ type: "text", text: "queued payload" }], details: {} },
		options,
		theme,
		context,
	);
	assert.match(earlyMcpResult.render(100)[0], /queued payload/);
	const mcp = api.decorateTool(
		{
			name: "mcp",
			label: "MCP",
			description: "MCP proxy",
			parameters: {},
			execute: async () => ({ content: [] }),
		},
		{ kind: "mcp", overrideExistingRenderers: true },
	);
	const mcpResult = mcp.renderResult(
		{ content: [{ type: "text", text: "large payload" }], details: {} },
		options,
		theme,
		context,
	);
	assert.match(mcpResult.render(100)[0], /large payload/);

	// A later composer owns its replacement; queued-decoration cleanup must not
	// clobber it while restoring the properties still installed here.
	const postDecorationCallRenderer = () => ({ render: () => ["post-decoration call"] });
	earlyMcp.renderCall = postDecorationCallRenderer;

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
	// Shutdown must restore the other methods and leave the retained wrapper inert.
	const installedGetCallRenderer = toolExecutionPrototype.getCallRenderer;
	const composedGetCallRenderer = function () {
		return installedGetCallRenderer.call(this);
	};
	toolExecutionPrototype.getCallRenderer = composedGetCallRenderer;

	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, {});
	}
	assert.equal(globalThis[apiKey], undefined);
	assert.equal(toolExecutionPrototype.getCallRenderer, composedGetCallRenderer);
	assert.equal(toolExecutionPrototype.getCallRenderer.call(lateMcpInstance), adapterCallRenderer);
	assert.equal(toolExecutionPrototype.getResultRenderer, originalGetResultRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell, originalGetRenderShell);
	assert.equal(earlyMcp.renderResult, undefined);
	assert.equal(earlyMcp.renderCall, postDecorationCallRenderer);
	assert.equal(earlyMcp.renderShell, undefined);

	const optInConfig = {
		...configModule.DEFAULT_TOOL_OUTPUT_CONFIG,
		registerToolOverrides: {
			...configModule.DEFAULT_TOOL_OUTPUT_CONFIG.registerToolOverrides,
			edit: true,
			write: true,
		},
	};
	assert.equal(configModule.saveToolOutputConfig(optInConfig).success, true);
	const optInTools = new Map();
	const optInHandlers = new Map();
	factory({
		registerTool(tool) {
			optInTools.set(tool.name, tool);
		},
		registerCommand() {},
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
	assert.notEqual(toolExecutionPrototype.getCallRenderer, composedGetCallRenderer);
	assert.deepEqual([...optInTools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	assert.equal(typeof optInTools.get("edit").renderCall, "function");
	assert.equal(typeof optInTools.get("edit").renderResult, "function");
	assert.equal(typeof optInTools.get("write").renderCall, "function");
	assert.equal(typeof optInTools.get("write").renderResult, "function");
	for (const handler of optInHandlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "quit" }, {});
	}
	assert.equal(globalThis[apiKey], undefined);
	assert.equal(toolExecutionPrototype.getCallRenderer, composedGetCallRenderer);
	assert.equal(toolExecutionPrototype.getCallRenderer.call(lateMcpInstance), adapterCallRenderer);
	assert.equal(toolExecutionPrototype.getResultRenderer, originalGetResultRenderer);
	assert.equal(toolExecutionPrototype.getRenderShell, originalGetRenderShell);
	toolExecutionPrototype.getCallRenderer = originalGetCallRenderer;
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
