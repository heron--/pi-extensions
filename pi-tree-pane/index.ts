import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { TreePaneLayout } from "./layout.ts";
import { ConversationPane } from "./messages.ts";

const WIDGET_KEY = "pi-tree-pane-bridge";

export default function treePaneExtension(pi: ExtensionAPI): void {
	let pane: TreePaneLayout | undefined;
	let stopInput: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// The zero-height widget receives Pi's TUI without replacing the editor,
		// footer, or header. Pi already reserves one row above the editor here.
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const messages = new ConversationPane(ctx.sessionManager, theme);
			const instance = new TreePaneLayout(tui, theme, messages);
			pane = instance;
			return {
				render: () => {
					instance.reconcile();
					return [];
				},
				invalidate: () => messages.invalidate(),
				dispose: () => {
					instance.disable();
					if (pane === instance) pane = undefined;
				},
			};
		});

		stopInput = ctx.ui.onTerminalInput((data) => {
			if (!pane?.isVisible || !pane.isEditorFocused || isKeyRelease(data)) return;
			if (matchesKey(data, "alt+k")) pane.scroll("up");
			else if (matchesKey(data, "alt+j")) pane.scroll("down");
			else if (matchesKey(data, "alt+g")) pane.scroll("end");
			else return;
			return { consume: true };
		});
	});

	pi.on("message_start", ({ message }) => {
		if (message.role === "user" || message.role === "assistant") pane?.setLive(message);
	});
	pi.on("message_update", ({ message }) => {
		if (message.role === "assistant") pane?.setLive(message);
	});
	pi.on("message_end", ({ message }) => {
		if (message.role === "user" || message.role === "assistant") pane?.setLive(message);
	});
	pi.on("agent_end", () => pane?.setLive(undefined));
	pi.on("session_tree", () => {
		pane?.setLive(undefined);
		pane?.refresh();
	});
	pi.on("session_compact", () => pane?.refresh());
	pi.on("session_shutdown", () => {
		stopInput?.();
		stopInput = undefined;
		pane?.disable();
		pane = undefined;
	});

	pi.registerCommand("tree-pane", {
		description: "Toggle the split transcript and conversation pane (fullscreen TUI)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /tree-pane [on|off|status]", "warning");
				return;
			}
			if (!pane) {
				ctx.ui.notify("Tree pane is available only in the interactive TUI.", "warning");
				return;
			}
			pane.reconcile();
			if (action === "status") {
				ctx.ui.notify(`Tree pane is ${pane.isEnabled ? "on" : "off"}.`, "info");
				return;
			}
			if (action === "off" || (!action && pane.isEnabled)) {
				pane.disable();
				ctx.ui.notify("Tree pane off.", "info");
				return;
			}
			const result = pane.enable();
			if (result === "fullscreen-required") {
				ctx.ui.notify("Tree pane needs fullscreen mode. Start pi with --tui-mode fullscreen.", "warning");
			} else if (result === "unsupported-layout") {
				ctx.ui.notify("Tree pane cannot identify pi's fullscreen transcript layout.", "error");
			} else {
				ctx.ui.notify("Tree pane on. Scroll the right pane with the mouse or Alt+K/J (Alt+G: latest).", "info");
			}
		},
	});
}
