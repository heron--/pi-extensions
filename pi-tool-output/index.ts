import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	keyHint,
	SettingsManager,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	BUILTIN_TOOL_NAMES,
	loadToolOutputConfig,
	saveToolOutputConfig,
	type CustomToolOverride,
	type OutputMode,
	type ToolOutputConfig,
} from "./config.ts";
import {
	TOOL_OUTPUT_API_KEY,
	TOOL_OUTPUT_PENDING_KEY,
	type RuntimeToolDefinition,
	type ToolOutputAdapter,
	type ToolOutputApi,
} from "./decorate.ts";
import {
	countNonEmptyLines,
	displayToolName,
	extractTextOutput,
	formatToolArguments,
	isKnownToolName,
	isLikelyQuietCommand,
	outputLines,
	pluralize,
	previewSlice,
	sanitizeAnsiForToolOutput,
	shortenPath,
} from "./rendering.ts";
import { toolCallBox, toolResultBox } from "./tool-box.ts";

type ResultLike = AgentToolResult<unknown>;
type DecoratedProperty = "renderCall" | "renderResult" | "renderShell";
type RuntimeCallRenderer = (args: unknown, theme: Theme, context: ToolRenderContextLike) => unknown;
type RuntimeResultRenderer = (
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
) => unknown;

interface ToolRenderContextLike {
	args: Record<string, unknown>;
	isError: boolean;
	state: Record<string, unknown>;
}

interface StoredDescriptors {
	renderCall?: PropertyDescriptor;
	renderResult?: PropertyDescriptor;
	renderShell?: PropertyDescriptor;
}

interface PendingDecoration {
	tool: RuntimeToolDefinition;
	adapter?: ToolOutputAdapter;
}

interface ToolExecutionInstanceLike {
	toolName?: string;
	toolDefinition?: RuntimeToolDefinition;
}

interface PatchedToolExecutionPrototype {
	getCallRenderer(this: ToolExecutionInstanceLike): RuntimeCallRenderer | undefined;
	getResultRenderer(this: ToolExecutionInstanceLike): RuntimeResultRenderer | undefined;
	getRenderShell(this: ToolExecutionInstanceLike): "default" | "self";
	__toolOutputOriginalGetCallRenderer?: PatchedToolExecutionPrototype["getCallRenderer"];
	__toolOutputOriginalGetResultRenderer?: PatchedToolExecutionPrototype["getResultRenderer"];
	__toolOutputOriginalGetRenderShell?: PatchedToolExecutionPrototype["getRenderShell"];
	__toolOutputPatchedBy?: symbol;
}

type ToolOutputGlobal = typeof globalThis & {
	[TOOL_OUTPUT_API_KEY]?: ToolOutputApi;
	[TOOL_OUTPUT_PENDING_KEY]?: PendingDecoration[];
};

interface BuiltinTools {
	read: ReturnType<typeof createReadToolDefinition>;
	grep: ReturnType<typeof createGrepToolDefinition>;
	find: ReturnType<typeof createFindToolDefinition>;
	ls: ReturnType<typeof createLsToolDefinition>;
	bash: ReturnType<typeof createBashToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
}

const builtinsByCwd = new Map<string, BuiltinTools>();
const DECORATED_PROPERTIES: DecoratedProperty[] = ["renderCall", "renderResult", "renderShell"];

function toRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringField(value: unknown, name: string): string | undefined {
	const field = toRecord(value)[name];
	return typeof field === "string" && field.trim() ? field : undefined;
}

function numberField(value: unknown, name: string): number | undefined {
	const field = toRecord(value)[name];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function createBuiltinTools(cwd: string, projectTrusted: boolean): BuiltinTools {
	const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
	return {
		read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		bash: createBashToolDefinition(cwd, {
			commandPrefix: settings.getShellCommandPrefix(),
			shellPath: settings.getShellPath(),
		}),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
	};
}

function getBuiltinTools(cwd: string, projectTrusted = false): BuiltinTools {
	const key = `${projectTrusted ? "trusted" : "untrusted"}\0${cwd}`;
	let tools = builtinsByCwd.get(key);
	if (!tools) {
		tools = createBuiltinTools(cwd, projectTrusted);
		builtinsByCwd.set(key, tools);
	}
	return tools;
}

function emptyResult(): Container {
	return new Container();
}

function textResult(text: string): Text {
	return new Text(text, 0, 0);
}

function isErrorResult(result: ResultLike, context: ToolRenderContextLike): boolean {
	return context.isError || toRecord(result).isError === true;
}

function expandedLineLimit(lines: string[], config: ToolOutputConfig): number {
	return config.expandedPreviewMaxLines === 0
		? lines.length
		: Math.min(lines.length, config.expandedPreviewMaxLines);
}

function previewLimit(lines: string[], options: ToolRenderResultOptions, collapsed: number, config: ToolOutputConfig): number {
	return options.expanded ? expandedLineLimit(lines, config) : collapsed;
}

function renderPreview(
	lines: string[],
	limit: number,
	options: ToolRenderResultOptions,
	config: ToolOutputConfig,
	theme: Theme,
	color: "dim" | "error" = "dim",
	footer?: string,
): Text | Container {
	if (lines.length === 0 && !footer) return emptyResult();
	const { shown, remaining } = previewSlice(lines, limit);
	let text = shown.map((line) => theme.fg(color, sanitizeAnsiForToolOutput(line))).join("\n");
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `… ${remaining} more ${pluralize(remaining, "line")} · ${keyHint("app.tools.expand", "to expand")}`)}`;
	}
	if (options.expanded && config.expandedPreviewMaxLines > 0 && lines.length > config.expandedPreviewMaxLines) {
		text += `\n${theme.fg("warning", `display capped at ${config.expandedPreviewMaxLines} lines`)}`;
	}
	if (footer) text += `${text ? "\n" : ""}${theme.fg("warning", footer)}`;
	return text ? textResult(text) : emptyResult();
}

function renderError(
	result: ResultLike,
	options: ToolRenderResultOptions,
	config: ToolOutputConfig,
	theme: Theme,
	fallback: string,
): Text {
	const lines = outputLines(extractTextOutput(result), options.expanded);
	if (lines.length === 0) return textResult(theme.fg("error", fallback));
	const limit = previewLimit(lines, options, config.previewLines, config);
	const preview = renderPreview(lines, limit, options, config, theme, "error");
	return preview instanceof Text ? preview : textResult(theme.fg("error", fallback));
}

function renderModeResult(
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
	config: ToolOutputConfig,
	mode: OutputMode,
	summary: (lines: string[]) => string,
): ReturnType<typeof toolResultBox> {
	let content: Text | Container;
	if (isErrorResult(result, context)) {
		content = renderError(result, options, config, theme, "Tool failed");
	} else if (options.isPartial || mode === "hidden") {
		content = emptyResult();
	} else {
		const lines = outputLines(extractTextOutput(result), options.expanded);
		content = mode === "summary" && !options.expanded
			? textResult(`${theme.fg("dim", summary(lines))} ${theme.fg("dim", `· ${keyHint("app.tools.expand", "to expand")}`)}`)
			: renderPreview(lines, previewLimit(lines, options, config.previewLines, config), options, config, theme);
	}
	return toolResultBox(content, theme, context);
}

function readCall(args: Record<string, unknown>, theme: Theme): Text {
	const path = shortenPath(stringField(args, "path"));
	const offset = numberField(args, "offset");
	const limit = numberField(args, "limit");
	let range = "";
	if (offset !== undefined || limit !== undefined) {
		const from = offset ?? 1;
		const to = limit !== undefined ? from + limit - 1 : undefined;
		range = to === undefined ? `:${from}` : `:${from}-${to}`;
	}
	return textResult(theme.fg("success", `path: ${path || "..."}${range}`));
}

function searchCall(
	name: "grep" | "find" | "ls",
	args: Record<string, unknown>,
	theme: Theme,
): Text {
	const scope = shortenPath(stringField(args, "path") ?? ".");
	const limit = numberField(args, "limit");
	const limitSuffix = limit === undefined ? "" : ` (limit ${limit})`;
	if (name === "grep") {
		const pattern = stringField(args, "pattern") ?? "";
		const glob = stringField(args, "glob");
		return textResult(
			theme.fg("success", `pattern: /${pattern}/ · path: ${scope}${glob ? ` · glob: ${glob}` : ""}${limitSuffix}`),
		);
	}
	if (name === "find") {
		return textResult(
			theme.fg("success", `pattern: ${stringField(args, "pattern") ?? ""} · path: ${scope}${limitSuffix}`),
		);
	}
	return textResult(theme.fg("success", `path: ${scope}${limitSuffix}`));
}

function bashCall(args: Record<string, unknown>, theme: Theme): Text {
	const command = stringField(args, "command") ?? "...";
	const timeout = numberField(args, "timeout");
	return textResult(
		theme.fg("success", `command: ${command}${timeout === undefined ? "" : ` · timeout: ${timeout}s`}`),
	);
}

function bashTruncationNotice(result: ResultLike): string | undefined {
	const details = toRecord(result.details);
	const truncation = toRecord(details.truncation);
	if (truncation.truncated !== true && typeof details.fullOutputPath !== "string") return undefined;
	const totalLines = numberField(truncation, "totalLines");
	const fullOutputPath = shortenPath(stringField(details, "fullOutputPath"));
	const size = totalLines === undefined ? "" : ` (${totalLines} total ${pluralize(totalLines, "line")})`;
	const path = fullOutputPath ? ` · full output: ${fullOutputPath}` : "";
	return `↳ output truncated${size}${path}`;
}

function bashResult(
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
	config: ToolOutputConfig,
): Text | Container {
	if (isErrorResult(result, context)) {
		return renderError(result, options, config, theme, "Command failed");
	}
	const rawOutput = extractTextOutput(result);
	const lines = rawOutput.trim() === "(no output)" ? [] : outputLines(rawOutput, options.expanded);
	const truncationNotice = bashTruncationNotice(result);
	if (options.isPartial) {
		return renderPreview(
			lines,
			previewLimit(lines, options, config.bashCollapsedLines, config),
			options,
			config,
			theme,
			"dim",
			truncationNotice,
		);
	}
	if (lines.length === 0) {
		const command = stringField(context.args, "command");
		const noOutput = theme.fg(
			"muted",
			isLikelyQuietCommand(command) ? "↳ command completed (no output)" : "↳ (no output)",
		);
		return textResult(truncationNotice ? `${noOutput}\n${theme.fg("warning", truncationNotice)}` : noOutput);
	}
	if (config.bashOutputMode === "summary" && !options.expanded) {
		const summary = `${theme.fg("muted", `↳ ${lines.length} ${pluralize(lines.length, "line")} returned`)} ${theme.fg("muted", `· ${keyHint("app.tools.expand", "to expand")}`)}`;
		return textResult(truncationNotice ? `${summary}\n${theme.fg("warning", truncationNotice)}` : summary);
	}
	const collapsedLimit = config.bashOutputMode === "preview" ? config.previewLines : config.bashCollapsedLines;
	if (!options.expanded && collapsedLimit === 0) {
		const hidden = theme.fg("muted", "↳ output hidden");
		return textResult(truncationNotice ? `${hidden}\n${theme.fg("warning", truncationNotice)}` : hidden);
	}
	return renderPreview(
		lines,
		previewLimit(lines, options, collapsedLimit, config),
		options,
		config,
		theme,
		"dim",
		truncationNotice,
	);
}

function adapterCall(
	tool: RuntimeToolDefinition,
	args: unknown,
	theme: Theme,
	context: ToolRenderContextLike,
): ReturnType<typeof toolCallBox> {
	const name = stringField(tool, "name") ?? "tool";
	const label = stringField(tool, "label");
	const argsText = theme.fg("success", formatToolArguments(args));
	return toolCallBox(displayToolName(name, label), textResult(argsText), theme, context);
}

function isMcpTool(tool: RuntimeToolDefinition): boolean {
	const name = stringField(tool, "name") ?? "";
	const label = stringField(tool, "label") ?? "";
	const description = stringField(tool, "description") ?? "";
	return name === "mcp" || /^mcp[_:-]/i.test(name) || /^MCP\b/.test(label) || /\bMCP\b/.test(description);
}

function configuredCustomOverride(tool: RuntimeToolDefinition, config: ToolOutputConfig): CustomToolOverride | undefined {
	const name = stringField(tool, "name");
	return name ? config.customToolOverrides[name] : undefined;
}

function installDecorationApi(getConfig: () => ToolOutputConfig): () => void {
	const target = globalThis as ToolOutputGlobal;
	const descriptorSnapshots = new Map<RuntimeToolDefinition, StoredDescriptors>();

	const api: ToolOutputApi = {
		version: 1,
		decorateTool<T extends object>(tool: T, adapter: ToolOutputAdapter = {}): T {
			const runtimeTool = tool as RuntimeToolDefinition;
			const config = getConfig();
			const custom = configuredCustomOverride(runtimeTool, config);
			if (custom?.enabled === false) return tool;

			const kind = custom?.kind ?? adapter.kind ?? (isMcpTool(runtimeTool) ? "mcp" : "generic");
			const mode = custom?.outputMode ?? adapter.outputMode ?? (kind === "mcp" ? config.mcpOutputMode : "summary");
			const overrideExisting = custom?.enabled === true || adapter.overrideExistingRenderers === true;
			const decorated: RuntimeToolDefinition = { ...runtimeTool };

			if (overrideExisting || typeof decorated.renderCall !== "function") {
				decorated.renderCall = (args: unknown, theme: Theme, context: ToolRenderContextLike) =>
					adapterCall(decorated, args, theme, context);
			}
			if (overrideExisting || typeof decorated.renderResult !== "function") {
				decorated.renderResult = (
					result: ResultLike,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: ToolRenderContextLike,
				) =>
					renderModeResult(
						result,
						options,
						theme,
						context,
						getConfig(),
						mode,
						(lines) => `↳ ${countNonEmptyLines(lines)} ${pluralize(countNonEmptyLines(lines), "line")} returned`,
					);
			}
			if (overrideExisting || decorated.renderShell === undefined) decorated.renderShell = "self";
			return decorated as T;
		},
	};

	target[TOOL_OUTPUT_API_KEY] = api;
	const pending = target[TOOL_OUTPUT_PENDING_KEY];
	if (Array.isArray(pending)) {
		for (const entry of pending.splice(0)) {
			if (!entry?.tool || typeof entry.tool !== "object") continue;
			const decorated = api.decorateTool(entry.tool, entry.adapter);
			if (decorated === entry.tool) continue;
			const snapshot: StoredDescriptors = {};
			for (const property of DECORATED_PROPERTIES) {
				const descriptor = Object.getOwnPropertyDescriptor(entry.tool, property);
				if (descriptor) snapshot[property] = descriptor;
			}
			descriptorSnapshots.set(entry.tool, snapshot);
			Object.assign(entry.tool, decorated);
		}
	}

	return () => {
		if (target[TOOL_OUTPUT_API_KEY] === api) delete target[TOOL_OUTPUT_API_KEY];
		for (const [tool, snapshot] of descriptorSnapshots) {
			for (const property of DECORATED_PROPERTIES) {
				const descriptor = snapshot[property];
				if (descriptor) Object.defineProperty(tool, property, descriptor);
				else delete tool[property];
			}
		}
	};
}

interface RuntimeRenderingTarget {
	tool: RuntimeToolDefinition;
	kind: "generic" | "mcp";
	mode: OutputMode;
}

function resolveRuntimeRenderingTarget(
	instance: ToolExecutionInstanceLike,
	config: ToolOutputConfig,
): RuntimeRenderingTarget | undefined {
	const definition = instance.toolDefinition ?? {};
	const name = instance.toolName ?? stringField(definition, "name");
	const tool = name && !stringField(definition, "name") ? { ...definition, name } : definition;
	const custom = name ? config.customToolOverrides[name] : undefined;
	if (custom) {
		return custom.enabled ? { tool, kind: custom.kind, mode: custom.outputMode } : undefined;
	}
	if (isMcpTool(tool)) return { tool, kind: "mcp", mode: config.mcpOutputMode };
	if (name && !(BUILTIN_TOOL_NAMES as readonly string[]).includes(name) && isKnownToolName(name)) {
		return { tool, kind: "generic", mode: "preview" };
	}
	return undefined;
}

const TOOL_EXECUTION_PATCH_OWNER = Symbol.for("pi-tool-output.tool-execution-patch.v1");
let installedCallRendererWrapper: PatchedToolExecutionPrototype["getCallRenderer"] | undefined;
let installedResultRendererWrapper: PatchedToolExecutionPrototype["getResultRenderer"] | undefined;
let installedRenderShellWrapper: PatchedToolExecutionPrototype["getRenderShell"] | undefined;
let installedPatchState: { active: boolean } | undefined;

/**
 * Pi exposes tool metadata, not registered definitions, through getAllTools().
 * The exported TUI component is therefore the only safe late seam for tools
 * that cannot import the decorator helper (notably installed MCP adapters).
 */
function patchToolExecutionRendering(getConfig: () => ToolOutputConfig): void {
	const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
	if (
		typeof prototype.getCallRenderer !== "function" ||
		typeof prototype.getResultRenderer !== "function" ||
		typeof prototype.getRenderShell !== "function" ||
		prototype.__toolOutputPatchedBy === TOOL_EXECUTION_PATCH_OWNER
	) {
		return;
	}

	prototype.__toolOutputOriginalGetCallRenderer ??= prototype.getCallRenderer;
	prototype.__toolOutputOriginalGetResultRenderer ??= prototype.getResultRenderer;
	prototype.__toolOutputOriginalGetRenderShell ??= prototype.getRenderShell;
	const originalCall = prototype.__toolOutputOriginalGetCallRenderer;
	const originalResult = prototype.__toolOutputOriginalGetResultRenderer;
	const originalShell = prototype.__toolOutputOriginalGetRenderShell;
	const patchState = { active: true };
	installedPatchState = patchState;

	installedCallRendererWrapper = function (this: ToolExecutionInstanceLike): RuntimeCallRenderer | undefined {
		if (!patchState.active) return originalCall.call(this);
		const target = resolveRuntimeRenderingTarget(this, getConfig());
		if (!target) return originalCall.call(this);
		return (args, theme, context) => adapterCall(target.tool, args, theme, context);
	};
	installedResultRendererWrapper = function (this: ToolExecutionInstanceLike): RuntimeResultRenderer | undefined {
		if (!patchState.active) return originalResult.call(this);
		const target = resolveRuntimeRenderingTarget(this, getConfig());
		if (!target) return originalResult.call(this);
		return (result, options, theme, context) =>
			renderModeResult(
				result,
				options,
				theme,
				context,
				getConfig(),
				target.mode,
				(lines) => {
					const count = countNonEmptyLines(lines);
					return `↳ ${count} ${pluralize(count, "line")} returned`;
				},
			);
	};
	installedRenderShellWrapper = function (this: ToolExecutionInstanceLike): "default" | "self" {
		if (!patchState.active) return originalShell.call(this);
		return resolveRuntimeRenderingTarget(this, getConfig()) ? "self" : originalShell.call(this);
	};

	prototype.getCallRenderer = installedCallRendererWrapper;
	prototype.getResultRenderer = installedResultRendererWrapper;
	prototype.getRenderShell = installedRenderShellWrapper;
	prototype.__toolOutputPatchedBy = TOOL_EXECUTION_PATCH_OWNER;
}

function unpatchToolExecutionRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
	if (installedPatchState) installedPatchState.active = false;
	if (
		installedCallRendererWrapper !== undefined &&
		prototype.getCallRenderer === installedCallRendererWrapper &&
		prototype.__toolOutputOriginalGetCallRenderer
	) {
		prototype.getCallRenderer = prototype.__toolOutputOriginalGetCallRenderer;
	}
	if (
		installedResultRendererWrapper !== undefined &&
		prototype.getResultRenderer === installedResultRendererWrapper &&
		prototype.__toolOutputOriginalGetResultRenderer
	) {
		prototype.getResultRenderer = prototype.__toolOutputOriginalGetResultRenderer;
	}
	if (
		installedRenderShellWrapper !== undefined &&
		prototype.getRenderShell === installedRenderShellWrapper &&
		prototype.__toolOutputOriginalGetRenderShell
	) {
		prototype.getRenderShell = prototype.__toolOutputOriginalGetRenderShell;
	}
	if (prototype.__toolOutputPatchedBy === TOOL_EXECUTION_PATCH_OWNER) {
		delete prototype.__toolOutputOriginalGetCallRenderer;
		delete prototype.__toolOutputOriginalGetResultRenderer;
		delete prototype.__toolOutputOriginalGetRenderShell;
		delete prototype.__toolOutputPatchedBy;
	}
	installedCallRendererWrapper = undefined;
	installedResultRendererWrapper = undefined;
	installedRenderShellWrapper = undefined;
	installedPatchState = undefined;
}

function registerBuiltinOverrides(pi: ExtensionAPI, config: ToolOutputConfig): void {
	const bootstrap = getBuiltinTools(process.cwd());
	if (config.registerToolOverrides.read) {
		pi.registerTool({
			...bootstrap.read,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).read.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return toolCallBox(displayToolName("read"), readCall(args, theme), theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderModeResult(
					result,
					options,
					theme,
					context,
					config,
					config.readOutputMode,
					(lines) => `↳ loaded ${lines.length} ${pluralize(lines.length, "line")}`,
				);
			},
		});
	}

	const searchSummary = (lines: string[], singular: string, plural?: string): string => {
		const count = countNonEmptyLines(lines);
		return `↳ ${count} ${pluralize(count, singular, plural)} returned`;
	};

	if (config.registerToolOverrides.grep) {
		pi.registerTool({
			...bootstrap.grep,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).grep.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return toolCallBox(displayToolName("grep"), searchCall("grep", args, theme), theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderModeResult(result, options, theme, context, config, config.searchOutputMode, (lines) =>
					searchSummary(lines, "match", "matches"),
				);
			},
		});
	}

	if (config.registerToolOverrides.find) {
		pi.registerTool({
			...bootstrap.find,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).find.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return toolCallBox(displayToolName("find"), searchCall("find", args, theme), theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderModeResult(result, options, theme, context, config, config.searchOutputMode, (lines) =>
					searchSummary(lines, "result"),
				);
			},
		});
	}

	if (config.registerToolOverrides.ls) {
		pi.registerTool({
			...bootstrap.ls,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).ls.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return toolCallBox(displayToolName("ls"), searchCall("ls", args, theme), theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderModeResult(result, options, theme, context, config, config.searchOutputMode, (lines) =>
					searchSummary(lines, "entry", "entries"),
				);
			},
		});
	}

	if (config.registerToolOverrides.bash) {
		pi.registerTool({
			...bootstrap.bash,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).bash.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return toolCallBox(displayToolName("bash"), bashCall(args, theme), theme, context);
			},
			renderResult(result, options, theme, context) {
				return toolResultBox(bashResult(result, options, theme, context, config), theme, context);
			},
		});
	}

	// Opt-in escape hatch: use Pi's built-in diff renderers until a richer
	// replacement is sourced. These remain false in the default config.
	if (config.registerToolOverrides.edit) {
		pi.registerTool({
			...bootstrap.edit,
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).edit.execute(id, params, signal, onUpdate, ctx);
			},
		});
	}
	if (config.registerToolOverrides.write) {
		pi.registerTool({
			...bootstrap.write,
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).write.execute(id, params, signal, onUpdate, ctx);
			},
		});
	}
}

function configSummary(config: ToolOutputConfig): string {
	const owned = Object.entries(config.registerToolOverrides)
		.filter(([, enabled]) => enabled)
		.map(([name]) => name)
		.join(", ");
	return [
		`Tool output is ${config.enabled ? "on" : "off"}`,
		`read=${config.readOutputMode}`,
		`search=${config.searchOutputMode}`,
		`mcp=${config.mcpOutputMode}`,
		`bash=${config.bashOutputMode}/${config.bashCollapsedLines}`,
		`owns=${owned || "none"}`,
	].join(" · ");
}

export default function toolOutputExtension(pi: ExtensionAPI): void {
	const loaded = loadToolOutputConfig();
	let config = loaded.config;
	let cleanupDecorationApi: (() => void) | undefined;

	if (config.enabled) {
		cleanupDecorationApi = installDecorationApi(() => config);
		registerBuiltinOverrides(pi, config);
	}

	pi.on("session_start", (_event, ctx) => {
		if (loaded.error) ctx.ui.notify(loaded.error, "warning");
		if (config.enabled && ctx.mode === "tui") patchToolExecutionRendering(() => config);
	});

	pi.on("session_shutdown", () => {
		unpatchToolExecutionRendering();
		cleanupDecorationApi?.();
		cleanupDecorationApi = undefined;
		builtinsByCwd.clear();
	});

	pi.registerCommand("tool-output", {
		description: "Toggle compact tool-output rendering",
		handler: async (args, ctx) => {
			const verb = (args ?? "").trim().toLowerCase();
			if (!verb || verb === "status") {
				ctx.ui.notify(configSummary(config), "info");
				return;
			}
			if (verb !== "on" && verb !== "off") {
				ctx.ui.notify("Usage: /tool-output [on|off|status]", "warning");
				return;
			}

			const enabled = verb === "on";
			if (config.enabled === enabled) {
				ctx.ui.notify(`Tool output is already ${verb}`, "info");
				return;
			}
			const next = { ...config, enabled };
			const saved = saveToolOutputConfig(next);
			if (!saved.success) {
				ctx.ui.notify(saved.error ?? "Could not save tool-output config", "error");
				return;
			}
			config = next;
			ctx.ui.notify(`Tool output ${enabled ? "enabled" : "disabled"}; reloading`, "info");
			await ctx.reload();
		},
	});
}
