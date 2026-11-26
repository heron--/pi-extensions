import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRenderers,
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
	drawsTool,
	loadToolOutputConfig,
	saveToolOutputConfig,
	type OutputMode,
	type ToolOutputConfig,
} from "./config.ts";
import { type Ink, paint } from "../lib/colors.ts";
import { loadToolOutputColors, TOOL_OUTPUT_COLORS, useToolOutputColors } from "./colors.ts";
import {
	countNonEmptyLines,
	displayToolName,
	extractTextOutput,
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
import { fileChanges, renderGroup, resolveGroup, type GroupMember } from "./group.ts";
import { diffViewOptions, type DiffViewOptions } from "./diff.ts";
import { readBeforeWrite, writeDetails } from "./file-changes.ts";
import { fileCallComponent } from "./file-view.ts";

type ResultLike = AgentToolResult<unknown>;
/** The runtime shape of a tool definition: whatever the registering extension put on it. */
type RuntimeToolDefinition = Record<string, unknown> & { name?: string };
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
	cwd?: string;
}

interface ToolExecutionInstanceLike {
	toolName?: string;
	toolDefinition?: RuntimeToolDefinition;
	ui?: { requestRender(): void };
}

type RenderMethod = (this: ToolExecutionInstanceLike, width: number) => string[];
type MouseMethod = (this: ToolExecutionInstanceLike, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

interface PatchedToolExecutionPrototype {
	render: RenderMethod;
	handleMouse: MouseMethod;
	__toolOutputOriginalRender?: RenderMethod;
	__toolOutputOriginalHandleMouse?: MouseMethod;
	__toolOutputPatchedBy?: symbol;
}

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
	color: Ink = TOOL_OUTPUT_COLORS.result.output,
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
	groupTheme = theme;
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

function isBuiltinTool(name: string): boolean {
	return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The renderers a call to `toolName` is drawn with. `base` is what pi would
 * use otherwise: the tool's own renderers, pi's built-in ones, or nothing for
 * a tool that is not registered (a resumed session's call to a tool that is
 * gone). Every tool gets the house view, unless its `tools` entry is `false`.
 * A built-in tool drawn here is the one registered here, which already has it.
 * The rest of the definition is kept, so the group still reads the tool's label.
 */
function houseRenderers(toolName: string, base: ToolRenderers | undefined, config: ToolOutputConfig): ToolRenderers | undefined {
	if (!drawsTool(config, toolName) || isBuiltinTool(toolName)) return base;
	const tool: RuntimeToolDefinition = { ...(base as RuntimeToolDefinition | undefined), name: toolName };
	const setting = config.tools[toolName] || {};
	const mode = setting.outputMode ?? (isMcpTool(tool) ? config.mcpOutputMode : "preview");
	const native = setting.expanded === "native" ? (base?.renderResult as RuntimeResultRenderer | undefined) : undefined;
	return {
		...base,
		renderShell: "self",
		renderCall: (args, theme, context) => adapterCall(tool, args, theme, context as ToolRenderContextLike),
		renderResult: (result, options, theme, context) =>
			(native?.(result, options, theme, context as ToolRenderContextLike) as Component | undefined) ??
			adapterResult(tool, result, options, theme, context as ToolRenderContextLike, config, mode),
	};
}

const TOOL_EXECUTION_PATCH_OWNER = Symbol.for("pi-tool-output.tool-execution-patch.v1");
let installedRenderWrapper: RenderMethod | undefined;
let installedHandleMouseWrapper: MouseMethod | undefined;
let installedPatchState: { active: boolean } | undefined;

/* -------------------------------------------------------------------------- */
/* Grouped layout state                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pi does not export its live theme. Every house call renderer runs before its
 * component draws, so `adapterCall` records it.
 */
let groupTheme: Theme | undefined;
/**
 * The newest call decides the expand-last target. Pi asks the tool-renderer
 * resolvers for a call's renderers once, as it creates the call, and calls are
 * created in transcript order, so `stampCreation` numbers each call's
 * renderers there. The newest call, if it is a group member, carries the hint
 * and is the shortcut's target; a newer call outside the groups (a tool that
 * keeps its own renderer) leaves neither pointing past it.
 */
const CREATED = Symbol.for("pi-tool-output.created.v1");
let createdCalls = 0;
/** The shortcut's target, once the newest call has drawn and turned out to be a member. */
let lastMember: WeakRef<GroupMember> | undefined;
/** Row owners from each leader's last render, for click routing. */
const groupRowOwners = new WeakMap<object, (GroupMember | undefined)[]>();

/**
 * Whether a tool component joins a group: every tool does, unless its `tools`
 * entry is `false`. Such a tool keeps its own output and ends the run.
 */
function isGroupMember(instance: ToolExecutionInstanceLike, config: ToolOutputConfig): boolean {
	return instance.toolName === undefined || drawsTool(config, instance.toolName);
}

function stampCreation(renderers: ToolRenderers | undefined): ToolRenderers | undefined {
	createdCalls++;
	lastMember = undefined;
	return renderers && ({ ...renderers, [CREATED]: createdCalls } as ToolRenderers);
}

function isNewestCall(instance: { toolDefinition?: Record<PropertyKey, unknown> }): boolean {
	return createdCalls > 0 && instance.toolDefinition?.[CREATED] === createdCalls;
}

/** Expand or collapse only the most recent call. */
function toggleLastMember(): void {
	const member = lastMember?.deref();
	if (!member) return;
	member.setExpanded(!member.expanded);
	(member as unknown as ToolExecutionInstanceLike).ui?.requestRender();
}

/**
 * Pi has no API for laying several calls out together, so the group layout
 * replaces the exported TUI component's own drawing and click handling. The
 * renderers each call is drawn with come from `houseRenderers`, through pi's
 * tool-renderer API.
 */
function patchToolExecutionRendering(getConfig: () => ToolOutputConfig): void {
	const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
	if (typeof prototype.render !== "function" || prototype.__toolOutputPatchedBy === TOOL_EXECUTION_PATCH_OWNER) return;

	prototype.__toolOutputOriginalRender ??= prototype.render;
	prototype.__toolOutputOriginalHandleMouse ??= prototype.handleMouse;
	const originalRender = prototype.__toolOutputOriginalRender;
	const originalHandleMouse = prototype.__toolOutputOriginalHandleMouse;
	const patchState = { active: true };
	installedPatchState = patchState;

	installedRenderWrapper = function (this: ToolExecutionInstanceLike, width: number): string[] {
		const config = getConfig();
		if (!patchState.active) return originalRender.call(this, width);
		const joins = isGroupMember(this, config);
		if (joins && isNewestCall(this)) lastMember = new WeakRef(this as unknown as GroupMember);
		if (!groupTheme || !joins) return originalRender.call(this, width);
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
			lastMember: role.members.find(isNewestCall),
			expandLastKey: config.expandLastKey,
			diff: diffOptions(config),
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

	prototype.render = installedRenderWrapper;
	prototype.handleMouse = installedHandleMouseWrapper;
	prototype.__toolOutputPatchedBy = TOOL_EXECUTION_PATCH_OWNER;
}

function unpatchToolExecutionRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as PatchedToolExecutionPrototype;
	if (installedPatchState) installedPatchState.active = false;
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
		delete prototype.__toolOutputOriginalRender;
		delete prototype.__toolOutputOriginalHandleMouse;
		delete prototype.__toolOutputPatchedBy;
	}
	installedRenderWrapper = undefined;
	installedHandleMouseWrapper = undefined;
	installedPatchState = undefined;
	lastMember = undefined;
	groupTheme = undefined;
}

function registerBuiltinOverrides(pi: ExtensionAPI, config: ToolOutputConfig): void {
	const bootstrap = getBuiltinTools(process.cwd());
	if (drawsTool(config, "read")) {
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

	if (drawsTool(config, "grep")) {
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

	if (drawsTool(config, "find")) {
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

	if (drawsTool(config, "ls")) {
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

	if (drawsTool(config, "bash")) {
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

	if (drawsTool(config, "edit")) {
		pi.registerTool({
			...bootstrap.edit,
			renderShell: "self",
			async execute(id, params, signal, onUpdate, ctx) {
				return getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).edit.execute(id, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return adapterCall({ name: "edit" }, args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return toolResultBox(fileResult("edit", result, options, theme, context, config), theme, context);
			},
		});
	}
	if (drawsTool(config, "write")) {
		pi.registerTool({
			...bootstrap.write,
			renderShell: "self",
			// The file as it was is gone once the write lands, so read it first and
			// record the change in the result, where it survives a reload.
			async execute(id, params, signal, onUpdate, ctx) {
				const before = readBeforeWrite(params.path, ctx.cwd);
				const result = await getBuiltinTools(ctx.cwd, ctx.isProjectTrusted()).write.execute(id, params, signal, onUpdate, ctx);
				return { ...result, details: writeDetails(before, params.content) };
			},
			renderCall(args, theme, context) {
				return adapterCall({ name: "write" }, args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return toolResultBox(fileResult("write", result, options, theme, context, config), theme, context);
			},
		});
	}
}

const diffOptionsCache = new WeakMap<ToolOutputConfig, DiffViewOptions>();

/** One options object per configuration, so caches keyed on it hold across frames. */
function diffOptions(config: ToolOutputConfig): DiffViewOptions {
	let options = diffOptionsCache.get(config);
	if (!options) diffOptionsCache.set(config, (options = diffViewOptions(config)));
	return options;
}

/**
 * An edit's or write's own result view, outside a group: the change counts
 * while collapsed, the diff view expanded, and the error when it failed.
 */
function fileResult(
	toolName: "edit" | "write",
	result: ResultLike,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContextLike,
	config: ToolOutputConfig,
): Component {
	const failed = isErrorResult(result, context);
	if (options.expanded || failed) {
		const view = fileCallComponent(
			{
				toolName,
				args: context.args,
				result: { ...result, isError: failed },
				isPartial: options.isPartial === true,
				argsComplete: true,
				cwd: context.cwd ?? process.cwd(),
			},
			theme,
			diffOptions(config),
		);
		if (view) return view;
	}
	const changes = fileChanges({ toolName, args: context.args, result });
	if (!changes || options.isPartial) return renderModeContent(result, options, theme, context, config, "summary", (lines) => `↳ ${lines[0] ?? "done"}`);
	const color = TOOL_OUTPUT_COLORS.result.summary;
	return textResult(paint(theme, color, `↳ +${changes.added} -${changes.removed} · ${keyHint("app.tools.expand", "to expand")}`));
}

function configSummary(config: ToolOutputConfig): string {
	const native = Object.entries(config.tools)
		.filter(([, setting]) => setting === false)
		.map(([name]) => name)
		.join(", ");
	return [
		`Tool output is ${config.enabled ? "on" : "off"}`,
		`read=${config.readOutputMode}`,
		`search=${config.searchOutputMode}`,
		`mcp=${config.mcpOutputMode}`,
		`bash=${config.bashOutputMode}/${config.bashCollapsedLines}`,
		`native=${native || "none"}`,
	].join(" · ");
}

export default function toolOutputExtension(pi: ExtensionAPI): void {
	const loaded = loadToolOutputConfig();
	let config = loaded.config;
	useToolOutputColors(loadToolOutputColors(config.colors).palette);
	// Renderers are swapped only in a TUI session, while the group layout is installed.
	let rendering = false;
	if (config.enabled) {
		registerBuiltinOverrides(pi, config);
		pi.registerToolRenderer((toolName, next) =>
			rendering ? stampCreation(houseRenderers(toolName, next(), config)) : next(),
		);
	}

	pi.on("session_start", (_event, ctx) => {
		if (loaded.error) ctx.ui.notify(loaded.error, "warning");
		if (loaded.problems.length > 0) ctx.ui.notify(`tool-output config: ${loaded.problems.join("; ")}.`, "warning");
		if (config.enabled && ctx.mode === "tui") {
			rendering = true;
			patchToolExecutionRendering(() => config);
		}
	});

	pi.on("session_shutdown", () => {
		rendering = false;
		unpatchToolExecutionRendering();
		builtinsByCwd.clear();
	});

	if (config.enabled) {
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
