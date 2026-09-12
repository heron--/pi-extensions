import { homedir } from "node:os";
import { sep } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

interface TextContent {
	type: string;
	text?: string;
}

interface ToolResultLike {
	content?: unknown;
}

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	read: "Read File",
	grep: "Search Files",
	find: "Find Files",
	ls: "List Directory",
	bash: "Run Command",
	edit: "Edit File",
	write: "Write File",
	mcp: "MCP Gateway",
	mcpScript: "MCP Script",
	subagent: "Subagent",
	subagent_supervisor: "Subagent Supervisor",
	ask_user_question: "Ask User",
	preview_export: "Export Preview",
	web_search: "Web Search",
	datadog: "Datadog",
	ddsetup: "Datadog Setup",
	ddconfig: "Datadog Config",
	ddtoolsets: "Datadog Toolsets",
	bg_delegate: "Background Delegate",
	bg_result: "Background Result",
	bg_run: "Background Command",
	bg_run_pi_attested: "Attested Pi Run",
	bg_status: "Background Status",
	bg_logs: "Background Logs",
	bg_kill: "Stop Background Task",
	fusion_reason: "Fusion Reason",
	fusion_investigate: "Fusion Investigation",
	fusion_research: "Fusion Research",
	fusion_validate: "Fusion Validation",
	"multi_tool_use.parallel": "Parallel Tools",
};

const QUIET_COMMAND_PREFIXES = [
	"cd",
	"mkdir",
	"rmdir",
	"rm",
	"mv",
	"cp",
	"touch",
	"chmod",
	"chown",
	"git add",
	"git checkout",
	"git switch",
	"git restore",
	"git reset",
	"git clean",
	"npm install",
	"pnpm install",
	"yarn install",
	"bun install",
	"pip install",
	"cargo fetch",
	"go mod tidy",
] as const;

/** Strip terminal control sequences before applying the house box's dim tone. */
export function sanitizeAnsiForToolOutput(text: string): string {
	return stripTerminalSequences(text);
}

export function displayToolName(name: string, label?: string): string {
	const mapped = TOOL_DISPLAY_NAMES[name];
	if (mapped) return mapped;
	if (name.startsWith("mcp__")) {
		const server = name.slice("mcp__".length);
		return server
			.split(/[_-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}
	if (label && label.trim() && label !== name) return label.trim();
	return name
		.split(/[._:-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ") || "Tool";
}

export function isKnownToolName(name: string): boolean {
	return name in TOOL_DISPLAY_NAMES || name.startsWith("mcp__");
}

function formatArgumentValue(value: unknown): string {
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || '""';
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function formatToolArguments(args: unknown): string {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return formatArgumentValue(args);
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return "(no arguments)";
	return entries.map(([name, value]) => `${name}: ${formatArgumentValue(value)}`).join(" · ");
}

export function extractTextOutput(result: ToolResultLike): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter(
			(block): block is TextContent =>
				typeof block === "object" &&
				block !== null &&
				(block as TextContent).type === "text" &&
				typeof (block as TextContent).text === "string",
		)
		.map((block) => block.text ?? "")
		.join("\n");
}

export function outputLines(text: string, expanded: boolean): string[] {
	if (!text) return [];
	const lines = text.replace(/\r/g, "").split("\n").map((line) => line.replace(/\t/g, "    "));
	while (lines.length > 0 && lines.at(-1)?.trim().length === 0) lines.pop();
	if (expanded) return lines;

	const compacted: string[] = [];
	let previousWasEmpty = false;
	for (const line of lines) {
		const empty = line.trim().length === 0;
		if (empty && previousWasEmpty) continue;
		compacted.push(line);
		previousWasEmpty = empty;
	}
	return compacted;
}

export function previewSlice(lines: string[], maximum: number): { shown: string[]; remaining: number } {
	const limit = Math.max(0, Math.floor(maximum));
	const shown = lines.slice(0, limit);
	return { shown, remaining: Math.max(0, lines.length - shown.length) };
}

export function countNonEmptyLines(lines: string[]): number {
	return lines.filter((line) => line.trim().length > 0).length;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

export function shortenPath(path: string | undefined): string {
	if (!path) return "";
	const home = homedir();
	if (path === home) return "~";
	return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

export function isLikelyQuietCommand(command: string | undefined): boolean {
	const first = command
		?.trim()
		.toLowerCase()
		.split(/&&|\|\||;/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!first) return false;
	return QUIET_COMMAND_PREFIXES.some((prefix) => first === prefix || first.startsWith(`${prefix} `));
}
