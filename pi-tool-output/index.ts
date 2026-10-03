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
import type { Component, KeyId, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
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
import { paint, TOOL_OUTPUT_COLORS, type ColorSpec } from "./colors.ts";
import {
	countNonEmptyLines,
	displayToolName,
	extractTextOutput,
	isKnownToolName,
	isLikelyQuietCommand,
	outputLines,
	pluralize,
	previewSlice,
	sanitizeAnsiForToolOutput,
	shortenPath,
} from "./rendering.ts";
import { toolCallBox, toolResultBox } from "./tool-box.ts";
import { callArgumentsComponent } from "./call-rendering.ts";
import { codemodeCallsComponent, codemodeFullOutputNotice, codemodeOutput } from "./codemode.ts";
import { rowCappedPreview, type RowCapState } from "./preview.ts";
import { renderGroup, resolveGroup, type GroupMember } from "./group.ts";

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
	expanded?: boolean;
	args: Record<string, unknown>;
	isError: boolean;
	state: Record<string, unknown>;
}

interface StoredDescriptors {
	renderCall?: PropertyDescriptor;
	renderResult?: PropertyDescriptor;
	renderShell?: PropertyDescriptor;
}

interface DecorationDescriptors {
	original: StoredDescriptors;
	installed: StoredDescriptors;
}

interface PendingDecoration {
	tool: RuntimeToolDefinition;
	adapter?: ToolOutputAdapter;
}

interface ToolExecutionInstanceLike {
	toolName?: string;
	toolDefinition?: RuntimeToolDefinition;
	ui?: { requestRender(): void };
}

type RenderMethod = (this: ToolExecutionInstanceLike, width: number) => string[];
type MouseMethod = (this: ToolExecutionInstanceLike, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

interface PatchedToolExecutionPrototype {
	getCallRenderer(this: ToolExecutionInstanceLike): RuntimeCallRenderer | undefined;
	getResultRenderer(this: ToolExecutionInstanceLike): RuntimeResultRenderer | undefined;
	getRenderShell(this: ToolExecutionInstanceLike): "default" | "self";
	render: RenderMethod;
	handleMouse: MouseMethod;
	__toolOutputOriginalGetCallRenderer?: PatchedToolExecutionPrototype["getCallRenderer"];
	__toolOutputOriginalGetResultRenderer?: PatchedToolExecutionPrototype["getResultRenderer"];
	__toolOutputOriginalGetRenderShell?: PatchedToolExecutionPrototype["getRenderShell"];
	__toolOutputOriginalRender?: RenderMethod;
	__toolOutputOriginalHandleMouse?: MouseMethod;
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

function samePropertyDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor): boolean {
	return (
		left !== undefined &&
		left.configurable === right.configurable &&
		left.enumerable === right.enumerable &&
		left.writable === right.writable &&
		left.value === right.value &&
		left.get === right.get &&
		left.set === right.set
	);
}

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

function moreOutputNotice({ lineCut, remaining }: RowCapState): string {
	const parts = [
		...(lineCut ? ["line continues"] : []),
		...(remaining > 0 ? [`${remaining} more ${pluralize(remaining, "line")}`] : []),
	];
	return `… ${parts.join(" · ")} · ${keyHint("app.tools.expand", "to expand")}`;
}

function renderPreview(
	lines: string[],
	limit: number,
	options: ToolRenderResultOptions,
	config: ToolOutputConfig,
	theme: Theme,
	color: ColorSpec = TOOL_OUTPUT_COLORS.result.output,
	footer?: string,
): Component {
	if (lines.length === 0 && !footer) return emptyResult();
	if (!options.expanded) {
		return rowCappedPreview({
			lines: lines.map(sanitizeAnsiForToolOutput),
			maxRows: limit,
			paintLine: (line) => paint(theme, color, line),
			moreNotice: (state) => paint(theme, TOOL_OUTPUT_COLORS.result.meta, moreOutputNotice(state)),
			footer: footer ? paint(theme, TOOL_OUTPUT_COLORS.result.notice, footer) : undefined,
		});
	}
	const { shown } = previewSlice(lines, limit);
	let text = shown.map((line) => paint(theme, color, sanitizeAnsiForToolOutput(line))).join("\n");
	if (options.expanded && config.expandedPreviewMaxLines > 0 && lines.length > config.expandedPreviewMaxLines) {
		text += `\n${paint(theme, TOOL_OUTPUT_COLORS.result.notice, `display capped at ${config.expandedPreviewMaxLines} lines`)}`;
	}
	if (footer) text += `${text ? "\n" : ""}${paint(theme, TOOL_OUTPUT_COLORS.result.notice, footer)}`;
	return text ? textResult(text) : emptyResult();
}

function renderError(
	result: ResultLike,
	options: ToolRenderResultOptions,
	config: ToolOutputConfig,
	theme: Theme,
	fallback: string,
	footer?: string,
): Component {
	const lines = outputLines(extractTextOutput(result), options.expanded);
	const { error, notice } = TOOL_OUTPUT_COLORS.result;
	if (lines.length === 0) {
		const message = paint(theme, error, fallback);
		return textResult(footer ? `${message}\n${paint(theme, notice, footer)}` : message);
	}
	const limit = previewLimit(lines, options, config.previewLines, config);
	return renderPreview(lines, limit, options, config, theme, error, footer);
}

function renderModeContent(
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
	config: ToolOutputConfig,
	mode: OutputMode,
	summary: (lines: string[]) => string,
	footer?: string,
): Component {
	if (isErrorResult(result, context)) return renderError(result, options, config, theme, "Tool failed", footer);
	if (options.isPartial || mode === "hidden") return emptyResult();
	const lines = outputLines(extractTextOutput(result), options.expanded);
	if (mode === "summary" && !options.expanded) {
		const color = TOOL_OUTPUT_COLORS.result.summary;
		const notice = footer ? `\n${paint(theme, TOOL_OUTPUT_COLORS.result.notice, footer)}` : "";
		return textResult(`${paint(theme, color, summary(lines))} ${paint(theme, color, `· ${keyHint("app.tools.expand", "to expand")}`)}${notice}`);
	}
	return renderPreview(lines, previewLimit(lines, options, config.previewLines, config), options, config, theme, undefined, footer);
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
	return toolResultBox(renderModeContent(result, options, theme, context, config, mode, summary), theme, context);
}

function adapterResult(
	tool: RuntimeToolDefinition,
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
	config: ToolOutputConfig,
	mode: OutputMode,
): ReturnType<typeof toolResultBox> {
	const summary = (lines: string[]) => `↳ ${countNonEmptyLines(lines)} ${pluralize(countNonEmptyLines(lines), "line")} returned`;
	if (tool.name !== "codemode") return renderModeResult(result, options, theme, context, config, mode, summary);
	const content = new Container();
	if (mode !== "hidden" || isErrorResult(result, context)) {
		content.addChild(codemodeCallsComponent(result.details, options.expanded, theme, config.previewLines));
	}
	content.addChild(renderModeContent(
		codemodeOutput(result), options, theme, context, config, mode, summary, codemodeFullOutputNotice(result.details),
	));
	return toolResultBox(content, theme, context);
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
): Component {
	const truncationNotice = bashTruncationNotice(result);
	const { output, meta, notice } = TOOL_OUTPUT_COLORS.result;
	const withNotice = (text: string) => (truncationNotice ? `${text}\n${paint(theme, notice, truncationNotice)}` : text);
	if (isErrorResult(result, context)) {
		return renderError(result, options, config, theme, "Command failed", truncationNotice);
	}
	const rawOutput = extractTextOutput(result);
	const lines = rawOutput.trim() === "(no output)" ? [] : outputLines(rawOutput, options.expanded);
	if (options.isPartial) {
		return renderPreview(
			lines,
			previewLimit(lines, options, config.bashCollapsedLines, config),
			options,
			config,
			theme,
			output,
			truncationNotice,
		);
	}
	if (lines.length === 0) {
		const command = stringField(context.args, "command");
		const noOutput = paint(
			theme,
			meta,
			isLikelyQuietCommand(command) ? "↳ command completed (no output)" : "↳ (no output)",
		);
		return textResult(withNotice(noOutput));
	}
	if (config.bashOutputMode === "summary" && !options.expanded) {
		const summary = `${paint(theme, meta, `↳ ${lines.length} ${pluralize(lines.length, "line")} returned`)} ${paint(theme, meta, `· ${keyHint("app.tools.expand", "to expand")}`)}`;
		return textResult(withNotice(summary));
	}
	const collapsedLimit = config.bashOutputMode === "preview" ? config.previewLines : config.bashCollapsedLines;
	if (!options.expanded && collapsedLimit === 0) {
		return textResult(withNotice(paint(theme, meta, "↳ output hidden")));
	}
	return renderPreview(
		lines,
		previewLimit(lines, options, collapsedLimit, config),
		options,
		config,
		theme,
		output,
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
	return toolCallBox(
		displayToolName(name, label),
		callArgumentsComponent(name, args, context.expanded === true, theme),
		theme,
		context,
	);
}

function isMcpTool(tool: RuntimeToolDefinition): boolean {
	const name = stringField(tool, "name") ?? "";
	// Codemode can call MCP tools, but its own rendering is not an MCP output mode.
	if (name === "codemode") return false;
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
	const descriptorSnapshots = new Map<RuntimeToolDefinition, DecorationDescriptors>();

	const api: ToolOutputApi = {
		version: 1,
		decorateTool<T extends object>(tool: T, adapter: ToolOutputAdapter = {}): T {
			const runtimeTool = tool as RuntimeToolDefinition;
			const config = getConfig();
			const custom = configuredCustomOverride(runtimeTool, config);
			if (custom?.enabled === false) return tool;

			const kind = custom?.kind ?? adapter.kind ?? (isMcpTool(runtimeTool) ? "mcp" : "generic");
			const mode = custom?.outputMode ?? adapter.outputMode ?? (kind === "mcp" ? config.mcpOutputMode : runtimeTool.name === "codemode" ? "preview" : "summary");
			const overrideExisting = custom?.enabled === true || adapter.overrideExistingRenderers === true;
			const hasExistingRenderer =
				typeof runtimeTool.renderCall === "function" || typeof runtimeTool.renderResult === "function";
			if (hasExistingRenderer && !overrideExisting) return tool;

			const decorated: RuntimeToolDefinition = { ...runtimeTool };
			decorated.renderCall = (args: unknown, theme: Theme, context: ToolRenderContextLike) =>
				adapterCall(decorated, args, theme, context);
			decorated.renderResult = (
				result: ResultLike,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: ToolRenderContextLike,
			) =>
				adapterResult(decorated, result, options, theme, context, getConfig(), mode);
			decorated.renderShell = "self";
			markHouseRenderer(decorated.renderCall);
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
			const existing = descriptorSnapshots.get(entry.tool);
			const original: StoredDescriptors = existing?.original ?? {};
			if (!existing) {
				for (const property of DECORATED_PROPERTIES) {
					const descriptor = Object.getOwnPropertyDescriptor(entry.tool, property);
					if (descriptor) original[property] = descriptor;
				}
			}
			Object.assign(entry.tool, decorated);
			const installed: StoredDescriptors = {};
			for (const property of DECORATED_PROPERTIES) {
				const descriptor = Object.getOwnPropertyDescriptor(entry.tool, property);
				if (descriptor) installed[property] = descriptor;
			}
			descriptorSnapshots.set(entry.tool, { original, installed });
		}
	}

	return () => {
		if (target[TOOL_OUTPUT_API_KEY] === api) delete target[TOOL_OUTPUT_API_KEY];
		for (const [tool, snapshot] of descriptorSnapshots) {
			for (const property of DECORATED_PROPERTIES) {
				const current = Object.getOwnPropertyDescriptor(tool, property);
				const installed = snapshot.installed[property];
				if (!installed || !samePropertyDescriptor(current, installed)) continue;
				const original = snapshot.original[property];
				if (original) Object.defineProperty(tool, property, original);
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
let installedRenderWrapper: RenderMethod | undefined;
let installedHandleMouseWrapper: MouseMethod | undefined;
let installedPatchState: { active: boolean } | undefined;

/* -------------------------------------------------------------------------- */
/* Grouped layout state                                                        */
/* -------------------------------------------------------------------------- */

const HOUSE_RENDERER = Symbol.for("pi-tool-output.house-renderer.v1");

/** Tag a renderCall this extension installed, so the component holding it joins groups. */
function markHouseRenderer(renderer: unknown): void {
	if (typeof renderer === "function") (renderer as unknown as Record<symbol, boolean>)[HOUSE_RENDERER] = true;
}

/** Pi does not export its live theme; every member's call renderer runs before it draws, so record it there. */
let groupTheme: Theme | undefined;
/** The most recently created member: the expand-last shortcut's target, and the only row with the hint. */
let lastMember: WeakRef<GroupMember> | undefined;
const seenMembers = new WeakSet<object>();
/** Row owners from each leader's last render, for click routing. */
const groupRowOwners = new WeakMap<object, (GroupMember | undefined)[]>();

/**
 * Whether a tool component draws in the house box — and so joins a group.
 * pi's builtins always do (edit/write keep their own renderer for the
 * expanded view), as do adapted tools; any other tool keeps its own output and
 * ends the run.
 */
function isGroupMember(instance: ToolExecutionInstanceLike, config: ToolOutputConfig): boolean {
	if (config.layout !== "grouped") return false;
	const name = instance.toolName;
	if (name && (BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) return true;
	const renderCall = instance.toolDefinition?.renderCall as Record<symbol, unknown> | undefined;
	if (typeof renderCall === "function" && renderCall[HOUSE_RENDERER] === true) return true;
	return resolveRuntimeRenderingTarget(instance, config) !== undefined;
}

function noteMember(instance: ToolExecutionInstanceLike): void {
	if (seenMembers.has(instance)) return;
	seenMembers.add(instance);
	lastMember = new WeakRef(instance as unknown as GroupMember);
}

/** Expand or collapse only the most recent call. */
function toggleLastMember(): void {
	const member = lastMember?.deref();
	if (!member) return;
	member.setExpanded(!member.expanded);
	(member as unknown as ToolExecutionInstanceLike).ui?.requestRender();
}

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
	prototype.__toolOutputOriginalRender ??= prototype.render;
	prototype.__toolOutputOriginalHandleMouse ??= prototype.handleMouse;
	const originalCall = prototype.__toolOutputOriginalGetCallRenderer;
	const originalResult = prototype.__toolOutputOriginalGetResultRenderer;
	const originalShell = prototype.__toolOutputOriginalGetRenderShell;
	const originalRender = prototype.__toolOutputOriginalRender;
	const originalHandleMouse = prototype.__toolOutputOriginalHandleMouse;
	const patchState = { active: true };
	installedPatchState = patchState;

	installedCallRendererWrapper = function (this: ToolExecutionInstanceLike): RuntimeCallRenderer | undefined {
		if (!patchState.active) return originalCall.call(this);
		const config = getConfig();
		const target = resolveRuntimeRenderingTarget(this, config);
		const renderer: RuntimeCallRenderer | undefined = target
			? (args, theme, context) => adapterCall(target.tool, args, theme, context)
			: originalCall.call(this);
		if (!renderer || !isGroupMember(this, config)) return renderer;
		noteMember(this);
		return (args, theme, context) => {
			groupTheme = theme;
			return renderer(args, theme, context);
		};
	};
	installedResultRendererWrapper = function (this: ToolExecutionInstanceLike): RuntimeResultRenderer | undefined {
		if (!patchState.active) return originalResult.call(this);
		const target = resolveRuntimeRenderingTarget(this, getConfig());
		if (!target) return originalResult.call(this);
		return (result, options, theme, context) =>
			adapterResult(target.tool, result, options, theme, context, getConfig(), target.mode);
	};
	installedRenderShellWrapper = function (this: ToolExecutionInstanceLike): "default" | "self" {
		if (!patchState.active) return originalShell.call(this);
		return resolveRuntimeRenderingTarget(this, getConfig()) ? "self" : originalShell.call(this);
	};

	installedRenderWrapper = function (this: ToolExecutionInstanceLike, width: number): string[] {
		const config = getConfig();
		if (!patchState.active || !groupTheme || !isGroupMember(this, config)) return originalRender.call(this, width);
		const member = this as unknown as GroupMember;
		const role = resolveGroup(member, this.ui, width, (component): component is GroupMember =>
			component instanceof ToolExecutionComponent && isGroupMember(component as unknown as ToolExecutionInstanceLike, config),
		);
		if (role.kind === "follower") {
			groupRowOwners.delete(this);
			return [];
		}
		const group = renderGroup(role.members, width, {
			theme: groupTheme,
			lastMember: lastMember?.deref(),
			expandLastKey: config.expandLastKey,
		});
		groupRowOwners.set(this, group.owners);
		return group.lines;
	};
	installedHandleMouseWrapper = function (this: ToolExecutionInstanceLike, event: TuiMouseEvent) {
		if (!patchState.active || !groupRowOwners.has(this)) return originalHandleMouse.call(this, event);
		if (event.type !== "click" || event.button !== "left") return undefined;
		const owner = groupRowOwners.get(this)?.[event.y];
		if (!owner) return undefined;
		owner.setExpanded(!owner.expanded);
		this.ui?.requestRender();
		return { handled: true };
	};

	prototype.getCallRenderer = installedCallRendererWrapper;
	prototype.getResultRenderer = installedResultRendererWrapper;
	prototype.getRenderShell = installedRenderShellWrapper;
	prototype.render = installedRenderWrapper;
	prototype.handleMouse = installedHandleMouseWrapper;
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
	if (
		installedRenderWrapper !== undefined &&
		prototype.render === installedRenderWrapper &&
		prototype.__toolOutputOriginalRender
	) {
		prototype.render = prototype.__toolOutputOriginalRender;
	}
	if (
		installedHandleMouseWrapper !== undefined &&
		prototype.handleMouse === installedHandleMouseWrapper &&
		prototype.__toolOutputOriginalHandleMouse
	) {
		prototype.handleMouse = prototype.__toolOutputOriginalHandleMouse;
	}
	if (prototype.__toolOutputPatchedBy === TOOL_EXECUTION_PATCH_OWNER) {
		delete prototype.__toolOutputOriginalGetCallRenderer;
		delete prototype.__toolOutputOriginalGetResultRenderer;
		delete prototype.__toolOutputOriginalGetRenderShell;
		delete prototype.__toolOutputOriginalRender;
		delete prototype.__toolOutputOriginalHandleMouse;
		delete prototype.__toolOutputPatchedBy;
	}
	installedCallRendererWrapper = undefined;
	installedResultRendererWrapper = undefined;
	installedRenderShellWrapper = undefined;
	installedRenderWrapper = undefined;
	installedHandleMouseWrapper = undefined;
	installedPatchState = undefined;
	lastMember = undefined;
	groupTheme = undefined;
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
				return adapterCall({ name: "read" }, args, theme, context);
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
				return adapterCall({ name: "grep" }, args, theme, context);
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
				return adapterCall({ name: "find" }, args, theme, context);
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
				return adapterCall({ name: "ls" }, args, theme, context);
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
				return adapterCall({ name: "bash" }, args, theme, context);
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
		`layout=${config.layout}`,
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

	if (config.enabled && config.layout === "grouped") {
		pi.registerShortcut(config.expandLastKey as KeyId, {
			description: "Expand or collapse the most recent tool call",
			handler: () => toggleLastMember(),
		});
	}

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
