import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const BASH_OUTPUT_MODES = ["opencode", "summary", "preview"] as const;
export const CUSTOM_TOOL_KINDS = ["generic", "mcp"] as const;
export const BUILTIN_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

export type OutputMode = (typeof OUTPUT_MODES)[number];
export type BashOutputMode = (typeof BASH_OUTPUT_MODES)[number];
export type CustomToolKind = (typeof CUSTOM_TOOL_KINDS)[number];
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface ToolOwnership {
	read: boolean;
	grep: boolean;
	find: boolean;
	ls: boolean;
	bash: boolean;
	edit: boolean;
	write: boolean;
}

export interface CustomToolOverride {
	enabled: boolean;
	kind: CustomToolKind;
	outputMode: OutputMode;
}

export interface ToolOutputConfig {
	enabled: boolean;
	registerToolOverrides: ToolOwnership;
	customToolOverrides: Record<string, CustomToolOverride>;
	readOutputMode: OutputMode;
	searchOutputMode: OutputMode;
	mcpOutputMode: OutputMode;
	previewLines: number;
	expandedPreviewMaxLines: number;
	bashOutputMode: BashOutputMode;
	bashCollapsedLines: number;
}

export const DEFAULT_TOOL_OUTPUT_CONFIG: ToolOutputConfig = {
	enabled: true,
	registerToolOverrides: {
		read: true,
		grep: true,
		find: true,
		ls: true,
		bash: true,
		// Keep pi-tool-display's diff renderer until a replacement is sourced.
		edit: false,
		write: false,
	},
	customToolOverrides: {},
	readOutputMode: "preview",
	searchOutputMode: "preview",
	mcpOutputMode: "preview",
	previewLines: 8,
	expandedPreviewMaxLines: 4000,
	bashOutputMode: "opencode",
	bashCollapsedLines: 10,
};

export interface ConfigLoadResult {
	config: ToolOutputConfig;
	error?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function asOutputMode(value: unknown, fallback: OutputMode): OutputMode {
	return OUTPUT_MODES.includes(value as OutputMode) ? (value as OutputMode) : fallback;
}

function asBashOutputMode(value: unknown, fallback: BashOutputMode): BashOutputMode {
	return BASH_OUTPUT_MODES.includes(value as BashOutputMode) ? (value as BashOutputMode) : fallback;
}

function asCustomToolKind(value: unknown): CustomToolKind {
	return CUSTOM_TOOL_KINDS.includes(value as CustomToolKind) ? (value as CustomToolKind) : "generic";
}

function normalizeOwnership(value: unknown): ToolOwnership {
	const source = isRecord(value) ? value : {};
	const defaults = DEFAULT_TOOL_OUTPUT_CONFIG.registerToolOverrides;
	return {
		read: asBoolean(source.read, defaults.read),
		grep: asBoolean(source.grep, defaults.grep),
		find: asBoolean(source.find, defaults.find),
		ls: asBoolean(source.ls, defaults.ls),
		bash: asBoolean(source.bash, defaults.bash),
		edit: asBoolean(source.edit, defaults.edit),
		write: asBoolean(source.write, defaults.write),
	};
}

function normalizeCustomToolOverride(value: unknown): CustomToolOverride | undefined {
	if (typeof value === "boolean") {
		return { enabled: value, kind: "generic", outputMode: "summary" };
	}
	if (!isRecord(value)) return undefined;
	return {
		enabled: asBoolean(value.enabled, true),
		kind: asCustomToolKind(value.kind),
		outputMode: asOutputMode(value.outputMode, "summary"),
	};
}

function normalizeCustomToolOverrides(value: unknown): Record<string, CustomToolOverride> {
	if (!isRecord(value)) return {};
	const overrides: Record<string, CustomToolOverride> = {};
	for (const [rawName, rawOverride] of Object.entries(value)) {
		const name = rawName.trim();
		if (!name || (BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) continue;
		const override = normalizeCustomToolOverride(rawOverride);
		if (override) overrides[name] = override;
	}
	return overrides;
}

export function normalizeToolOutputConfig(value: unknown): ToolOutputConfig {
	const source = isRecord(value) ? value : {};
	return {
		enabled: asBoolean(source.enabled, DEFAULT_TOOL_OUTPUT_CONFIG.enabled),
		registerToolOverrides: normalizeOwnership(source.registerToolOverrides),
		customToolOverrides: normalizeCustomToolOverrides(source.customToolOverrides),
		readOutputMode: asOutputMode(source.readOutputMode, DEFAULT_TOOL_OUTPUT_CONFIG.readOutputMode),
		searchOutputMode: asOutputMode(source.searchOutputMode, DEFAULT_TOOL_OUTPUT_CONFIG.searchOutputMode),
		mcpOutputMode: asOutputMode(source.mcpOutputMode, DEFAULT_TOOL_OUTPUT_CONFIG.mcpOutputMode),
		previewLines: asInteger(source.previewLines, 1, 80, DEFAULT_TOOL_OUTPUT_CONFIG.previewLines),
		expandedPreviewMaxLines: asInteger(
			source.expandedPreviewMaxLines,
			0,
			20_000,
			DEFAULT_TOOL_OUTPUT_CONFIG.expandedPreviewMaxLines,
		),
		bashOutputMode: asBashOutputMode(source.bashOutputMode, DEFAULT_TOOL_OUTPUT_CONFIG.bashOutputMode),
		bashCollapsedLines: asInteger(
			source.bashCollapsedLines,
			0,
			80,
			DEFAULT_TOOL_OUTPUT_CONFIG.bashCollapsedLines,
		),
	};
}

export function getToolOutputConfigPath(): string {
	return join(getAgentDir(), "pi-tool-output", "config.json");
}

export function loadToolOutputConfig(path = getToolOutputConfigPath()): ConfigLoadResult {
	try {
		return { config: normalizeToolOutputConfig(JSON.parse(readFileSync(path, "utf8")) as unknown) };
	} catch (error) {
		const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
		return {
			config: normalizeToolOutputConfig(undefined),
			...(missing ? {} : { error: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}` }),
		};
	}
}

export function saveToolOutputConfig(config: ToolOutputConfig, path = getToolOutputConfigPath()): ConfigSaveResult {
	const normalized = normalizeToolOutputConfig(config);
	const temporaryPath = `${path}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, path);
		return { success: true };
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		return {
			success: false,
			error: `Could not save ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
