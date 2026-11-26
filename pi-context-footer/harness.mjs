// A fake pi host for the footer's tests: it loads the extension, starts a
// session against synthetic data, and renders the framed editor and the
// footer the way pi's TUI would ask for them. Nothing here touches a real
// model, provider, session file, or the owner's configuration.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { testTheme } from "../lib/test-theme.mjs";

/** Every escape sequence — CSI, OSC and the rest — for comparing visible text. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g;
export const plain = (line) => line.replace(ESCAPES, "");

/**
 * Pi's editor reduced to its rows: a rule, the input, a rule, and any
 * completion rows after it. A scrolled input swaps a rule for a marker.
 */
function fakeEditorFactory(state) {
	return () => ({
		borderColor: undefined,
		getText: () => state.input,
		render(width) {
			const rule = (marker) => {
				if (!marker) return "─".repeat(width);
				const head = `─── ${marker} `;
				return head + "─".repeat(Math.max(0, width - visibleWidth(head)));
			};
			const body = state.input.split("\n").map((line) => line.slice(0, width).padEnd(width));
			const completions = state.completions.map((line) => line.slice(0, width).padEnd(width));
			return [rule(state.scrolledAbove), ...body, rule(state.scrolledBelow), ...completions];
		},
	});
}

export function usageOf(input, output, extra = {}) {
	return {
		input, output, cacheRead: extra.cacheRead ?? 0, cacheWrite: extra.cacheWrite ?? 0, totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: extra.cost ?? 0 },
	};
}

export function assistantEntry(id, usage) {
	return {
		type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z",
		message: { role: "assistant", content: [], provider: "synthetic", model: "synthetic-model", usage, stopReason: "stop", timestamp: 0 },
	};
}

/**
 * A scratch agent directory and a `demo-repo` working directory, so the
 * directory item and the config file are the same on every machine.
 * `pullRequest` is what the stand-in for `gh` answers (see `startFooter`).
 */
export function scratch({ config, pullRequest } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-context-footer-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "demo-repo");
	mkdirSync(join(agentDir, "pi-context-footer"), { recursive: true });
	mkdirSync(cwd);
	if (config !== undefined) {
		writeFileSync(join(agentDir, "pi-context-footer", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return { root, agentDir, cwd, pullRequest, configFile: join(agentDir, "pi-context-footer", "config.json") };
}

/**
 * Load the extension at `modulePath` into a fake pi and start a session.
 * `env` is applied before the module loads; the host restores nothing, so
 * each test file uses its own process.
 */
export async function startFooter(modulePath, options = {}) {
	const dirs = options.dirs ?? scratch(options);
	process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
	// The pull-request lookup, in process instead of `gh`: it records each
	// lookup as the `gh` arguments it stands for and answers on a later tick,
	// as a child process would, with `pullRequest` or no pull request.
	const ghCalls = [];
	const runPullRequest = (cwd, branch, done) => {
		ghCalls.push(`${cwd} pr view ${branch} --json number,url`);
		setImmediate(() => done(dirs.pullRequest ?? null));
	};

	const handlers = new Map();
	const commands = new Map();
	// pi's own bus, so subscriptions and delivery behave as they do in pi.
	const events = createEventBus();
	const pi = {
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name, command) => commands.set(name, command),
		events,
	};

	const state = {
		input: options.input ?? "hello",
		completions: [],
		scrolledAbove: null,
		scrolledBelow: null,
		branch: options.branch === undefined ? "feature/demo" : options.branch,
		statuses: new Map(Object.entries(options.statuses ?? {})),
		sessionName: options.sessionName ?? null,
		entries: options.entries ?? [assistantEntry("a1", usageOf(1200, 300, { cacheRead: 500 }))],
		leafId: "a1",
		notifications: [],
		renderRequests: 0,
	};
	const theme = options.theme ?? testTheme();
	const branchListeners = new Set();
	const provider = {
		getGitBranch: () => state.branch,
		getExtensionStatuses: () => state.statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange(listener) {
			branchListeners.add(listener);
			return () => branchListeners.delete(listener);
		},
	};
	const tui = { requestRender: () => state.renderRequests++ };
	let footer;
	let editor;
	const ui = {
		theme,
		notify: (message, type) => state.notifications.push({ message, type }),
		setFooter(factory) {
			footer?.dispose?.();
			footer = factory ? factory(tui, theme, provider) : undefined;
		},
		getEditorComponent: () => options.previousEditorFactory ?? fakeEditorFactory(state),
		setEditorComponent(factory) {
			editor = factory ? factory(tui, {}, {}) : undefined;
		},
		setStatus: (key, text) => (text === undefined ? state.statuses.delete(key) : state.statuses.set(key, text)),
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: options.model === undefined
			? { id: "synthetic-model", name: "Synthetic Model", reasoning: true, contextWindow: 200_000 }
			: options.model,
		thinkingLevel: options.thinkingLevel ?? "high",
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 }),
		sessionManager: {
			getCwd: () => dirs.cwd,
			getSessionName: () => state.sessionName ?? undefined,
			getEntries: () => state.entries,
			getSessionId: () => "session-1",
			getLeafId: () => state.leafId,
		},
		ui,
	};

	const { createContextFooter } = await import(modulePath);
	createContextFooter(runPullRequest)(pi);
	const emit = async (event, payload = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};
	await emit("session_start", { reason: "startup" });

	return {
		dirs,
		/** Every pull-request lookup so far, as `<cwd> <gh arguments>`; clear it to start over. */
		ghCalls,
		state,
		ctx,
		emit,
		/** Emit on pi's event bus and let its async listeners run. */
		async publish(channel, data) {
			events.emit(channel, data);
			await new Promise((resolve) => setImmediate(resolve));
		},
		/** The framed editor at `width`. */
		renderEditor: (width) => editor.render(width),
		/** The footer at `width`: empty while the frame carries the layout. */
		renderFooter: (width) => footer?.render(width) ?? null,
		hasFooter: () => footer !== undefined,
		command: (args) => commands.get("context-footer").handler(args, ctx),
		changeBranch(branch) {
			state.branch = branch;
			for (const listener of branchListeners) listener();
		},
		async shutdown() {
			await emit("session_shutdown");
			ui.setFooter(undefined);
		},
	};
}
