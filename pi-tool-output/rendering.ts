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
	codemode: "Code Mode",
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

/**
 * Nerd Font glyphs beside each display name, so a column of calls scans by
 * shape before text. All from the Font Awesome range every Nerd Font ships.
 */
const ICON_DEFAULT = "\uf0ad"; // nf-fa-wrench
const TOOL_ICONS: Readonly<Record<string, string>> = {
	read: "\uf15c", // nf-fa-file_text
	grep: "\uf002", // nf-fa-search
	find: "\uf07c", // nf-fa-folder_open
	ls: "\uf03a", // nf-fa-list
	bash: "\uf120", // nf-fa-terminal
	edit: "\uf044", // nf-fa-pencil_square_o
	write: "\uf0c7", // nf-fa-floppy_o
	mcp: "\uf1e6", // nf-fa-plug
	mcpScript: "\uf1e6",
	codemode: "\uf121", // nf-fa-code
	subagent: "\uf0c0", // nf-fa-users
	subagent_supervisor: "\uf0c0",
	ask_user_question: "\uf128", // nf-fa-question
	preview_export: "\uf1c1", // nf-fa-file_pdf_o
	web_search: "\uf0ac", // nf-fa-globe
	datadog: "\uf080", // nf-fa-bar_chart
	ddsetup: "\uf080",
	ddconfig: "\uf080",
	ddtoolsets: "\uf080",
	bg_delegate: "\uf0c0",
	bg_result: "\uf00c", // nf-fa-check
	bg_run: "\uf04b", // nf-fa-play
	bg_run_pi_attested: "\uf04b",
	bg_status: "\uf017", // nf-fa-clock_o
	bg_logs: "\uf15c",
	bg_kill: "\uf04d", // nf-fa-stop
	fusion_reason: "\uf0eb", // nf-fa-lightbulb_o
	fusion_investigate: "\uf0eb",
	fusion_research: "\uf0eb",
	fusion_validate: "\uf0eb",
	"multi_tool_use.parallel": "\uf0e8", // nf-fa-sitemap
};

export function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? (name.startsWith("mcp__") ? TOOL_ICONS.mcp! : ICON_DEFAULT);
}

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
	let displayName: string;
	if (mapped) {
		displayName = mapped;
	} else if (name.startsWith("mcp__")) {
		const server = name.slice("mcp__".length);
		displayName = server
			.split(/[_-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	} else if (label && label.trim() && label !== name) {
		displayName = label;
	} else {
		displayName = name
			.split(/[._:-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}
	return stripTerminalSequences(displayName).replace(/\s+/g, " ").trim() || "Tool";
}

export function isKnownToolName(name: string): boolean {
	return name in TOOL_DISPLAY_NAMES || name.startsWith("mcp__");
}

export { formatToolArguments } from "./arguments.ts";

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
