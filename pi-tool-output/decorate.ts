export type RuntimeToolDefinition = Record<string, unknown>;

export interface ToolOutputAdapter {
	kind?: "generic" | "mcp";
	outputMode?: "hidden" | "summary" | "preview";
	overrideExistingRenderers?: boolean;
}

export interface ToolOutputApi {
	version: 1;
	decorateTool<T extends object>(tool: T, adapter?: ToolOutputAdapter): T;
}

interface PendingDecoration {
	tool: RuntimeToolDefinition;
	adapter?: ToolOutputAdapter;
}

type ToolOutputGlobal = typeof globalThis & {
	[TOOL_OUTPUT_API_KEY]?: ToolOutputApi;
	[TOOL_OUTPUT_PENDING_KEY]?: PendingDecoration[];
};

export const TOOL_OUTPUT_API_KEY = Symbol.for("pi-tool-output.api.v1");
export const TOOL_OUTPUT_PENDING_KEY = Symbol.for("pi-tool-output.pending-decorations.v1");

export function getToolOutputApi(): ToolOutputApi | undefined {
	const api = (globalThis as ToolOutputGlobal)[TOOL_OUTPUT_API_KEY];
	return api?.version === 1 && typeof api.decorateTool === "function" ? api : undefined;
}

export function queueToolOutputDecoration<T extends object>(tool: T, adapter?: ToolOutputAdapter): T {
	const target = globalThis as ToolOutputGlobal;
	const pending = target[TOOL_OUTPUT_PENDING_KEY] ?? [];
	pending.push({ tool: tool as RuntimeToolDefinition, adapter });
	target[TOOL_OUTPUT_PENDING_KEY] = pending;
	return tool;
}

/** Decorate now when the renderer is loaded, or queue an in-place late decoration. */
export function decorateToolOutput<T extends object>(tool: T, adapter?: ToolOutputAdapter): T {
	const api = getToolOutputApi();
	return api ? api.decorateTool(tool, adapter) : queueToolOutputDecoration(tool, adapter);
}

/** MCP tools intentionally hand their existing renderers over to this extension. */
export function decorateMcpToolOutput<T extends object>(tool: T): T {
	return decorateToolOutput(tool, { kind: "mcp", overrideExistingRenderers: true });
}
