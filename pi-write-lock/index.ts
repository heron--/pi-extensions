import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "write-lock-state";
const STATUS_ID = "write-lock";
const BUILTIN_WRITE_TOOLS = new Set(["edit", "write"]);

interface WriteLockState {
	locked: boolean;
	writeToolsBeforeLock?: string[];
}

const DIRECT_MUTATION_TOOL_NAMES = new Set([
	"apply_patch",
	"copy_file",
	"create_file",
	"delete_file",
	"edit",
	"edit_file",
	"move_file",
	"patch",
	"rename_file",
	"write",
	"write_file",
]);

interface ShellMutationPattern {
	pattern: RegExp;
	description: string;
}

/**
 * Common file-mutating shell operations. This is deliberately a balanced,
 * useful guard rather than a shell sandbox: normal read-only commands and
 * test commands remain available, while obvious mutations are blocked.
 */
const SHELL_MUTATION_PATTERNS: ShellMutationPattern[] = [
	{ pattern: /(^|[^<])>{1,2}(?![>&])/m, description: "output redirection" },
	{ pattern: /(^|[;&|()]|\s)(tee|sponge)\b/i, description: "a file-writing command" },
	{ pattern: /(^|[;&|()]|\s)(rm|rmdir|unlink|shred|truncate)\b/i, description: "file deletion or truncation" },
	{ pattern: /(^|[;&|()]|\s)(mv|cp|install|mkdir|touch|mktemp|ln)\b/i, description: "file creation or movement" },
	{ pattern: /(^|[;&|()]|\s)(chmod|chown|chgrp|setfacl)\b/i, description: "file metadata changes" },
	{ pattern: /(^|[;&|()]|\s)(patch|ed|ex|vim|vi|nano|emacs)\b/i, description: "a file editing command" },
	{ pattern: /\bsed\b[^\n;&|]*\s-i(?:\s|$|["'])/i, description: "in-place sed editing" },
	{ pattern: /\b(perl|ruby)\b[^\n;&|]*\s-i(?:\s|$|["'])/i, description: "in-place script editing" },
	{ pattern: /\b(prettier|biome)\b[^\n;&|]*\s--write\b/i, description: "formatter write mode" },
	{ pattern: /\beslint\b[^\n;&|]*\s--fix\b/i, description: "linter fix mode" },
	{ pattern: /\bgofmt\b[^\n;&|]*\s-w\b/i, description: "formatter write mode" },
	{ pattern: /\brustfmt\b/i, description: "formatter write mode" },
	{ pattern: /\bcargo\s+fmt\b/i, description: "formatter write mode" },
	{ pattern: /\b(curl|wget)\b[^\n;&|]*(\s-o\s|\s--output(?:=|\s)|\s-O(?:\s|$))/i, description: "download to a file" },
	{ pattern: /(^|[;&|()]|\s)(scp|rsync)\b/i, description: "file copying" },
	{ pattern: /\btar\b[^\n;&|]*\s-[^\s]*x/i, description: "archive extraction" },
	{ pattern: /(^|[;&|()]|\s)(unzip|gunzip|bunzip2|unxz)\b/i, description: "archive extraction" },
	{
		pattern:
			/\bgit\s+(add|am|apply|branch|checkout|cherry-pick|clean|clone|commit|fetch|init|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|worktree)\b/i,
		description: "a git command that can change the worktree or repository",
	},
	{
		pattern: /\b(npm|pnpm|yarn|bun)\s+(add|ci|install|link|remove|uninstall|update|upgrade|publish)\b/i,
		description: "a package-manager mutation",
	},
	{
		pattern: /\b(pip|pip3)\s+(install|uninstall)\b/i,
		description: "a package-manager mutation",
	},
	{
		pattern: /\b(apt|apt-get|brew|dnf|yum|pacman)\s+(install|remove|uninstall|upgrade|update)\b/i,
		description: "a package-manager mutation",
	},
	{ pattern: /\bdd\b[^\n;&|]*\bof=/i, description: "dd output to a file" },
	{
		pattern:
			/\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i,
		description: "a PowerShell file mutation",
	},
	{ pattern: /\[System\.IO\.File\]::(Write|Append|Create|Delete|Move|Copy)/i, description: "a .NET file mutation" },
];

function baseToolName(toolName: string): string {
	return toolName.toLowerCase().split(/[.:/]/).pop() ?? toolName.toLowerCase();
}

function isDirectMutationTool(toolName: string): boolean {
	return DIRECT_MUTATION_TOOL_NAMES.has(baseToolName(toolName));
}

export function detectShellMutation(command: string): string | undefined {
	return SHELL_MUTATION_PATTERNS.find(({ pattern }) => pattern.test(command))?.description;
}

function shellCommand(event: { toolName: string; input: unknown }): string | undefined {
	const name = baseToolName(event.toolName);
	if (name !== "bash" && name !== "powershell") return undefined;
	if (!event.input || typeof event.input !== "object") return undefined;

	const input = event.input as { command?: unknown; script?: unknown };
	if (typeof input.command === "string") return input.command;
	if (typeof input.script === "string") return input.script;
	return undefined;
}

export default function writeLockExtension(pi: ExtensionAPI): void {
	let locked = false;
	let writeToolsBeforeLock: string[] | undefined;

	function activeBuiltinWriteTools(): string[] {
		return pi.getActiveTools().filter((name) => BUILTIN_WRITE_TOOLS.has(name));
	}

	function disableBuiltinWriteTools(): void {
		const activeTools = pi.getActiveTools();
		if (activeTools.some((name) => BUILTIN_WRITE_TOOLS.has(name))) {
			pi.setActiveTools(activeTools.filter((name) => !BUILTIN_WRITE_TOOLS.has(name)));
		}
	}

	function rememberAndDisableBuiltinWriteTools(): void {
		writeToolsBeforeLock = [
			...new Set([...(writeToolsBeforeLock ?? []), ...activeBuiltinWriteTools()]),
		];
		disableBuiltinWriteTools();
	}

	function restoreBuiltinWriteTools(): void {
		if (!writeToolsBeforeLock || writeToolsBeforeLock.length === 0) return;
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...writeToolsBeforeLock])]);
	}

	function updateStatus(ctx: ExtensionContext): void {
		// Both states are published, not just the lock: a footer cannot tell
		// "unlocked" from "extension absent" if the status is cleared when the
		// lock is off. The wording is the contract other extensions read.
		ctx.ui.setStatus(
			STATUS_ID,
			locked
				? ctx.ui.theme.fg("warning", "write locked")
				: ctx.ui.theme.fg("dim", "write unlocked"),
		);
	}

	function persistState(): void {
		pi.appendEntry<WriteLockState>(STATE_ENTRY_TYPE, {
			locked,
			writeToolsBeforeLock: locked ? writeToolsBeforeLock : undefined,
		});
	}

	function setLocked(nextLocked: boolean, ctx: ExtensionContext): void {
		if (nextLocked === locked) {
			updateStatus(ctx);
			ctx.ui.notify(nextLocked ? "Write lock is already on" : "Write lock is already off", "info");
			return;
		}

		if (nextLocked) {
			locked = true;
			writeToolsBeforeLock = activeBuiltinWriteTools();
			rememberAndDisableBuiltinWriteTools();
			ctx.ui.notify("Write lock enabled. This session is read-only.", "warning");
		} else {
			locked = false;
			restoreBuiltinWriteTools();
			writeToolsBeforeLock = undefined;
			ctx.ui.notify("Write lock disabled. File modifications are allowed.", "info");
		}

		updateStatus(ctx);
		persistState();
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		// Undo the old branch's tool filtering before applying the target branch.
		if (locked) restoreBuiltinWriteTools();

		locked = false;
		writeToolsBeforeLock = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const state = entry.data as WriteLockState | undefined;
			if (!state || typeof state.locked !== "boolean") continue;
			locked = state.locked;
			writeToolsBeforeLock = state.writeToolsBeforeLock;
		}

		if (locked) {
			if (writeToolsBeforeLock === undefined) {
				writeToolsBeforeLock = activeBuiltinWriteTools();
			}
			disableBuiltinWriteTools();
		}
		updateStatus(ctx);
	}

	pi.registerCommand("write-lock", {
		description: "Toggle this session's file write lock",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "" || arg === "toggle") {
				setLocked(!locked, ctx);
				return;
			}
			if (arg === "on" || arg === "lock" || arg === "locked") {
				setLocked(true, ctx);
				return;
			}
			if (arg === "off" || arg === "unlock" || arg === "unlocked") {
				setLocked(false, ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(locked ? "Write lock: on (read-only)" : "Write lock: off (writes allowed)", "info");
				return;
			}
			ctx.ui.notify("Usage: /write-lock [on | off | toggle | status]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!locked) return undefined;

		// Another extension may have changed the active tools since the command
		// ran. Re-apply the lock immediately before every model turn.
		rememberAndDisableBuiltinWriteTools();

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Write lock (active)\nThis session is currently read-only. Do not attempt to create, edit, overwrite, move, rename, or delete files. Do not run shell commands that can modify files, repository state, permissions, dependencies, or generated artifacts. Use read-only inspection tools instead. If the task requires a change, explain that the write lock is active and ask the user to run /write-lock off.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!locked) return undefined;

		if (isDirectMutationTool(event.toolName)) {
			ctx.ui.notify(`Blocked ${event.toolName}: write lock is on`, "warning");
			return {
				block: true,
				reason: `Write lock is on: ${event.toolName} cannot modify files. Ask the user to run /write-lock off.`,
			};
		}

		const command = shellCommand(event);
		if (command !== undefined) {
			const mutation = detectShellMutation(command);
			if (mutation) {
				ctx.ui.notify(`Blocked shell command (${mutation}): write lock is on`, "warning");
				return {
					block: true,
					reason: `Write lock is on: blocked ${mutation}. Use read-only commands or ask the user to run /write-lock off.`,
				};
			}
		}

		return undefined;
	});
}
