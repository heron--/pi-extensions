/**
 * Semantic one-line summaries of a tool call's arguments.
 *
 * `summarizeToolCall` is the entry point renderers use; it sanitizes and bounds
 * whatever `summarize` returns. `summarize` is pure routing: a flat
 * `if (name === …)` chain mapping each tool family to one exported summarizer.
 *
 * A summarizer returns `undefined` when it has nothing useful to say, and the
 * caller falls back to the generic argument preview.
 */

import { shortArgument } from "./arguments.ts";
import { shortenPath } from "./rendering.ts";

export interface CallSummary {
	text: string;
	fields: string[];
	hidden?: boolean;
}

/** Longest summary text kept before it is clipped and flagged as `hidden`. */
const SUMMARY_MAX_CHARS = 480;

type Args = Record<string, unknown>;

function record(value: unknown): Args {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Args : {};
}

function str(args: Args, key: string): string {
	return typeof args[key] === "string" ? shortArgument(args[key]) : "";
}

function number(args: Args, key: string): number | undefined {
	return typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] : undefined;
}

/** `fields` name the arguments the summary consumed, so they are not repeated. */
function summary(text: string, ...fields: string[]): CallSummary {
	return { text, fields };
}

/** The `path` argument, abbreviated against the home directory. */
function pathOf(args: Args): string {
	return shortenPath(str(args, "path"));
}

// ---------------------------------------------------------------------------
// Shell command sketching
// ---------------------------------------------------------------------------

/** Environment assignment, e.g. `CI=1`. */
const ASSIGNMENT = /^[A-Za-z_][\w]*=/;
/** Interpreters whose `-c`/`-e` body is an inline script, not a useful argument. */
const INTERPRETER = /^(?:python[\d.]*|node|ruby|perl|[bz]?sh|zsh)$/;
/** An inline-script flag such as `-c`, `-e`, or `-ec`. */
const INLINE_SCRIPT_FLAG = /^-[a-z]*[ce]$/;
/** A command separator token. The empty alternative tolerates blank tokens. */
const SEPARATOR = /^(?:;|\|\|?|&&?|)$/;
/** A trailing separator, which is dropped from the finished sketch. */
const TRAILING_SEPARATOR = /^(?:;|\|\|?|&&?)$/;

const COMMAND_LIMITS = {
	/** Characters of the command read at all. */
	sourceChars: 4096,
	/** Tokens produced before tokenizing stops. */
	tokens: 80,
	/** Pipeline segments shown before the sketch is elided. */
	segments: 3,
	/** Tokens shown per segment. */
	segmentTokens: 10,
	/** Longest single token shown verbatim. */
	tokenChars: 80,
	/** Longest finished sketch. */
	summaryChars: 240,
} as const;

interface TokenizedCommand {
	tokens: string[];
	/** A heredoc was found; its body is deliberately not read. */
	heredoc: boolean;
	/** Input ended inside a quote or escape, so the sketch is incomplete. */
	unterminated: boolean;
}

/**
 * Split a command into words and separators, keeping quoted spans intact.
 *
 * Display-only: this is a sketch of shell syntax, never an execution or safety
 * decision. Quoted separators stay inside their word, and a heredoc stops
 * tokenizing so the body never reaches the screen.
 */
function tokenizeCommand(source: string): TokenizedCommand {
	const tokens: string[] = [];
	let word = "";
	let quote = "";
	let escaped = false;
	let heredoc = false;
	const flush = () => { if (word) tokens.push(word); word = ""; };
	for (let index = 0; index < source.length && tokens.length < COMMAND_LIMITS.tokens; index++) {
		const ch = source[index]!;
		if (escaped) { word += ch; escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { word += ch; escaped = true; continue; }
		if (quote) {
			word += ch;
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; word += ch; continue; }
		if (ch === "#" && !word) {
			while (index < source.length && source[index] !== "\n") index++;
			flush(); tokens.push(";");
		} else if (ch === "<" && source[index + 1] === "<") {
			flush(); heredoc = true; break;
		} else if (/[;|&\n]/.test(ch)) {
			flush();
			const doubled = (ch === "|" || ch === "&") && source[index + 1] === ch;
			tokens.push(ch === "\n" ? ";" : doubled ? ch + source[++index] : ch);
		} else if (/\s/.test(ch)) flush();
		else word += ch;
	}
	flush();
	return { tokens, heredoc, unterminated: Boolean(quote) || escaped };
}

/**
 * Render one pipeline segment: mask environment values, replace an inline
 * interpreter body with a label, and bound both token count and token length.
 */
function sketchSegment(tokens: readonly string[]): string {
	// Environment values and interpreter inline bodies obscure the useful command.
	const parts = tokens.map((token) => ASSIGNMENT.test(token) ? `${token.split("=", 1)[0]}=…` : token);
	const executable = parts.findIndex((token) => !ASSIGNMENT.test(token) && token !== "env");
	const program = parts[executable]?.split("/").at(-1) ?? "";
	if (INTERPRETER.test(program)) {
		const flag = parts.findIndex((token, index) => index > executable && INLINE_SCRIPT_FLAG.test(token));
		if (flag >= 0 && parts[flag + 1]) parts[flag + 1] = "<inline script>";
	}
	const shown = parts
		.slice(0, COMMAND_LIMITS.segmentTokens)
		.map((token) => token.length > COMMAND_LIMITS.tokenChars ? "<long argument>" : token)
		.join(" ");
	return shown + (parts.length > COMMAND_LIMITS.segmentTokens ? " …" : "");
}

/** Sketch segments joined by the separators between them, bounded in count. */
function sketchPipeline(tokens: readonly string[]): string[] {
	const parts: string[] = [];
	let segment: string[] = [];
	let count = 0;
	const emit = () => {
		if (!segment.length) return;
		parts.push(sketchSegment(segment));
		segment = [];
		count++;
	};
	for (const token of tokens) {
		if (SEPARATOR.test(token)) {
			emit();
			if (count >= COMMAND_LIMITS.segments) { parts.push("…"); break; }
			if (parts.length) parts.push(token);
		} else segment.push(token);
	}
	if (count < COMMAND_LIMITS.segments) emit();
	if (TRAILING_SEPARATOR.test(parts.at(-1) ?? "")) parts.pop();
	return parts;
}

/** A display-only shell sketch, not a shell parser or an execution/safety decision. */
export function summarizeCommand(command: string): string {
	const source = command.slice(0, COMMAND_LIMITS.sourceChars);
	const { tokens, heredoc, unterminated } = tokenizeCommand(source);
	const parts = sketchPipeline(tokens);
	if (heredoc) parts.push("· heredoc script");
	if (unterminated || command.length > source.length) parts.push("…");
	return shortArgument(parts.join(" ") || "shell command", COMMAND_LIMITS.summaryChars);
}

// ---------------------------------------------------------------------------
// Per-tool summarizers
// ---------------------------------------------------------------------------

/** `read` — path plus the requested line range. */
export function summarizeRead(args: Args): CallSummary | undefined {
	const path = pathOf(args);
	if (!path) return undefined;
	const from = number(args, "offset");
	const limit = number(args, "limit");
	const range = from !== undefined || limit !== undefined
		? `:${from ?? 1}${limit !== undefined ? `-${(from ?? 1) + limit - 1}` : ""}` : "";
	return summary(`path: ${path}${range}`, "path", "offset", "limit");
}

/** `grep` / `find` — the pattern and the scope it is applied to. */
export function summarizeSearch(name: string, args: Args): CallSummary | undefined {
	const pattern = str(args, "pattern");
	if (!pattern) return undefined;
	const glob = str(args, "glob");
	const shown = name === "grep" ? `/${pattern}/` : pattern;
	return summary(
		`pattern: ${shown} · path: ${pathOf(args) || "."}${glob ? ` · glob: ${glob}` : ""}`,
		"pattern", "path", "glob",
	);
}

/** `ls` — the listed directory, defaulting to the working directory. */
export function summarizeLs(args: Args): CallSummary {
	return summary(`path: ${pathOf(args) || "."}`, "path");
}

/** `bash` / `bg_run` — an optional task name plus a bounded command sketch. */
export function summarizeShell(args: Args): CallSummary | undefined {
	if (typeof args.command !== "string") return undefined;
	const command = summarizeCommand(args.command);
	const label = str(args, "name");
	// Only consume a short, unchanged command; scripts always retain a descriptor/hint.
	const fields = command === args.command ? ["command"] : [];
	return summary(`${label ? `${label} · ` : ""}${command}`, ...fields, "name");
}

/** `edit` / `write` — the target path only; never the payload. */
export function summarizeFileWrite(args: Args): CallSummary | undefined {
	const path = pathOf(args);
	return path ? summary(`path: ${path}`, "path") : undefined;
}

/** `web_search` — the query and its declared intent. */
export function summarizeWebSearch(args: Args): CallSummary | undefined {
	const query = str(args, "query");
	if (!query) return undefined;
	const intent = str(args, "intent");
	return summary(`${query}${intent ? ` · ${intent}` : ""}`, "query", "intent");
}

/** Declared preflight lanes, named where the manifest provides keys. */
function laneSummary(args: Args): string {
	const lanes = record(args.preflight).lanes;
	if (!Array.isArray(lanes) || !lanes.length) return "";
	const names = lanes.slice(0, 3).map((lane) => str(record(lane), "key")).filter(Boolean);
	const listed = names.length ? `: ${names.join(", ")}${lanes.length > 3 ? ", …" : ""}` : "";
	return ` · ${lanes.length} declared lanes${listed}`;
}

/**
 * `subagent` — a management action, or the dispatch mode plus declared lanes.
 * Embedded tasks and workflow scripts are never summarized, only labeled.
 */
export function summarizeSubagent(args: Args): CallSummary | undefined {
	const action = str(args, "action");
	if (action) {
		const id = str(args, "id");
		const topic = str(args, "topic");
		return summary(`${action}${id ? ` · ${id}` : ""}${topic ? ` · ${topic}` : ""}`, "action", "id", "topic");
	}
	const workflow = str(args, "workflow");
	const agent = str(args, "agent");
	const mode = workflow ? `workflow: ${workflow}`
		: agent ? `agent: ${agent}`
		: args.workflowScript ? "Scripted workflow"
		: args.workflowScriptPath ? `workflow: ${str(args, "workflowScriptPath")}`
		: "";
	if (!mode) return undefined;
	const flags = `${args.async === true ? " · async" : ""}${args.worktree === true ? " · worktree" : ""}`;
	return summary(
		`${mode}${laneSummary(args)}${flags}`,
		"workflow", "agent", "workflowScriptPath",
		...(args.async === true ? ["async"] : []),
		...(args.worktree === true ? ["worktree"] : []),
	);
}

/** Gateway fields worth showing when no specific tool is targeted, in priority order. */
const MCP_FALLBACK_FIELDS = ["action", "search", "describe", "connect", "instructions", "query", "server"] as const;

/** `mcp` / `datadog` / `mcp__*` — the targeted server and tool, or the gateway action. */
export function summarizeMcp(args: Args): CallSummary | undefined {
	const tool = str(args, "tool");
	if (tool) {
		const server = str(args, "server");
		return summary(`${server ? `${server} · ` : ""}${tool}`, "tool", "server");
	}
	for (const key of MCP_FALLBACK_FIELDS) {
		if (str(args, key)) return summary(`${key}: ${str(args, key)}`, key);
	}
	return args.list === true ? summary("List available tools", "list") : undefined;
}

/** `multi_tool_use.parallel` — how many calls, and the first few recipients. */
export function summarizeParallelTools(args: Args): CallSummary | undefined {
	if (!Array.isArray(args.tool_uses)) return undefined;
	const names = args.tool_uses.slice(0, 3).map((tool) => str(record(tool), "recipient_name")).filter(Boolean);
	const listed = names.length ? ` · ${names.join(", ")}${args.tool_uses.length > 3 ? ", …" : ""}` : "";
	return summary(`${args.tool_uses.length} parallel tools${listed}`);
}

/** `fusion_*` / `bg_delegate` / `bg_run_pi_attested` — the task's name or objective. */
export function summarizeNamedTask(args: Args): CallSummary | undefined {
	const key = str(args, "name") ? "name" : "objective";
	return str(args, key) ? summary(str(args, key), key) : undefined;
}

/** `bg_result` / `bg_status` / `bg_logs` / `bg_kill` — the task being addressed. */
export function summarizeBackgroundTask(args: Args): CallSummary | undefined {
	const taskId = str(args, "taskId");
	return taskId ? summary(`task: ${taskId}`, "taskId") : undefined;
}

/** `preview_export` — output format and the source being rendered. */
export function summarizePreviewExport(args: Args): CallSummary | undefined {
	const format = str(args, "format");
	if (!format) return undefined;
	const source = pathOf(args) || str(args, "source") || "latest response";
	return summary(`${format.toUpperCase()} · ${source}`, "format", "path", "source");
}

/** `ask_user_question` — how many questions, and the first one. */
export function summarizeAskUserQuestion(args: Args): CallSummary | undefined {
	if (!Array.isArray(args.questions)) return undefined;
	const first = str(record(args.questions[0]), "question");
	return summary(`${args.questions.length} questions · ${first}`);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const BACKGROUND_TASK_TOOLS = ["bg_result", "bg_status", "bg_logs", "bg_kill"];

/** Route a tool name to its summarizer. Unknown tools get no summary. */
function summarize(name: string, args: Args): CallSummary | undefined {
	if (name === "read") return summarizeRead(args);
	if (name === "grep" || name === "find") return summarizeSearch(name, args);
	if (name === "ls") return summarizeLs(args);
	if (name === "bash" || name === "bg_run") return summarizeShell(args);
	if (name === "edit" || name === "write") return summarizeFileWrite(args);
	if (name === "web_search") return summarizeWebSearch(args);
	if (name === "subagent") return summarizeSubagent(args);
	if (name === "mcp" || name === "datadog" || name.startsWith("mcp__")) return summarizeMcp(args);
	if (name === "mcpScript") return typeof args.code === "string" ? summary("MCP script") : undefined;
	if (name === "multi_tool_use.parallel") return summarizeParallelTools(args);
	if (name.startsWith("fusion_") || name === "bg_delegate" || name === "bg_run_pi_attested") {
		return summarizeNamedTask(args);
	}
	if (BACKGROUND_TASK_TOOLS.includes(name)) return summarizeBackgroundTask(args);
	if (name === "preview_export") return summarizePreviewExport(args);
	if (name === "ask_user_question") return summarizeAskUserQuestion(args);
	return undefined;
}

/**
 * Keep a summarized field out of the generic preview only when the summary
 * actually rendered its value. Unexpected scalar types must stay visible
 * rather than disappear because the summary substituted a default.
 */
function consumedFields(result: CallSummary, args: Args): string[] {
	return result.fields.filter((key) => {
		if (key === "offset" || key === "limit") return number(args, key) !== undefined;
		if (key === "async" || key === "worktree" || key === "list") return args[key] === true;
		return typeof args[key] === "string";
	});
}

/** Partial streaming arguments and third-party shapes must degrade to the generic preview. */
export function summarizeToolCall(name: string, args: unknown): CallSummary | undefined {
	try {
		const input = record(args);
		const result = summarize(name, input);
		if (!result) return undefined;
		return {
			...result,
			fields: consumedFields(result, input),
			text: shortArgument(result.text, SUMMARY_MAX_CHARS),
			hidden: result.text.length > SUMMARY_MAX_CHARS,
		};
	} catch {
		return undefined;
	}
}
