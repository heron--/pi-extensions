import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, HStack, ScrollView, VStack, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ConversationPane, type ConversationMessage } from "./messages.ts";

export const MIN_SPLIT_COLUMNS = 36;
export type EnableResult = "enabled" | "fullscreen-required" | "unsupported-layout";

// Pi exposes setLayoutRoot(), but not a getter for its fullscreen layout root.
// This is the sole private TUI field used by the extension; the shape is
// checked before replacing it, and the original root is restored on disable.
interface FullscreenRenderer extends TUI {
	readonly mode: "fullscreen";
	layoutRoot?: Component;
	setLayoutRoot(root: Component | undefined): void;
	getFocusedComponent(): Component | null;
}

class RightPane extends VStack {
	private readonly scroll: ScrollView;

	constructor(children: ConstructorParameters<typeof VStack>[0], scroll: ScrollView) {
		super(children);
		this.scroll = scroll;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
		if (event.type !== "wheel") return super.handleMouse?.(event);
		// Prevent Pi from falling back to the primary (left) transcript at the
		// right pane's scroll limits. The fullscreen TUI handles scrollbar drags
		// before dispatching mouse events to components.
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}
}

/** Numeric bases keep the panes equal; HStack's weighted grow is sequential. */
class HalfWidthStack extends HStack {
	setViewportWidth(width: number): void {
		const available = Math.max(0, Math.floor(width) - 1); // divider
		this.entries[0]!.basis = Math.floor(available / 2);
		this.entries[2]!.basis = Math.ceil(available / 2);
	}
}

/** Keeps Pi's original transcript ScrollView and input dock intact. */
export class TreePaneLayout {
	private originalRoot?: Component;
	private splitRoot?: Component;
	private split?: HalfWidthStack;
	private rightScroll?: ScrollView;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly messages: ConversationPane;

	constructor(tui: TUI, theme: Theme, messages: ConversationPane) {
		this.tui = tui;
		this.theme = theme;
		this.messages = messages;
	}

	private fullscreenRenderer(): FullscreenRenderer | undefined {
		if (this.tui.mode !== "fullscreen") return undefined;
		const renderer = this.tui as FullscreenRenderer;
		return typeof renderer.setLayoutRoot === "function" ? renderer : undefined;
	}

	get isEnabled(): boolean {
		return this.splitRoot !== undefined && this.fullscreenRenderer()?.layoutRoot === this.splitRoot;
	}

	get isVisible(): boolean {
		return this.isEnabled && this.tui.terminal.columns >= MIN_SPLIT_COLUMNS;
	}

	/** A mode switch or another root owner detaches the split without replacing its root. */
	reconcile(): void {
		if (this.isEnabled) {
			this.split?.setViewportWidth(this.tui.terminal.columns);
		} else if (this.splitRoot) {
			this.originalRoot = undefined;
			this.splitRoot = undefined;
			this.split = undefined;
			this.rightScroll = undefined;
		}
	}

	enable(): EnableResult {
		this.reconcile();
		if (this.isEnabled) return "enabled";
		const renderer = this.fullscreenRenderer();
		if (!renderer) return "fullscreen-required";

		const root = renderer.layoutRoot;
		if (!(root instanceof VStack) || root.children.length !== 2) return "unsupported-layout";
		const [transcript, dock] = root.children;
		if (!(transcript instanceof ScrollView) || transcript.children[0] !== renderer.children[0] || !(dock instanceof VStack)) {
			return "unsupported-layout";
		}

		const side = new ScrollView(this.messages, {
			follow: "end",
			overscroll: "contain",
			scrollbar: "always",
			scrollbarTrackStyle: (text) => this.theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => this.theme.fg("scrollbarThumb", text),
		});
		const divider: Component = {
			render: () => Array.from({ length: Math.max(1, renderer.terminal.rows) }, () => this.theme.fg("border", "│")),
			invalidate: () => {},
		};
		const title: Component = {
			render: (width) => {
				const w = Math.max(1, width);
				if (w < 3) return [" ".repeat(w)];
				const row = (text: string) => ` ${truncateToWidth(text, w - 2, "", true)} `;
				const stats = this.messages.getStats();
				const summary = `${stats.userMessages} User Messages · ${stats.assistantMessages} Assistant Messages · ${stats.totalTurns} Total Turns`;
				const heading = this.theme.fg("muted", this.theme.bold("Conversation"));
				const detail = this.theme.fg("muted", summary);
				const combined = `${heading}${this.theme.fg("muted", ` - ${summary}`)}`;
				return visibleWidth(combined) <= w - 2 ? [row(combined)] : [row(heading), row(detail)];
			},
			invalidate: () => {},
		};
		const right = new RightPane([
			{ component: title, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
			{ component: side, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		], side);
		const splitVisible = ({ width }: { width: number }) => width >= MIN_SPLIT_COLUMNS;
		const split = new HalfWidthStack([
			{ component: transcript, basis: 0, grow: 1, minSize: 1 },
			{ component: divider, basis: 1, grow: 0, shrink: 0, minSize: 1, visible: splitVisible },
			{ component: right, basis: 0, grow: 0, minSize: 1, visible: splitVisible },
		]);
		split.setViewportWidth(renderer.terminal.columns);
		// The fullscreen dock keeps its original components, widths, focus, and
		// vertical sizing. Only the transcript slot becomes two columns.
		const splitRoot = new VStack([
			{ component: split, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.originalRoot = root;
		this.splitRoot = splitRoot;
		this.split = split;
		this.rightScroll = side;
		renderer.setLayoutRoot(splitRoot);
		return "enabled";
	}

	disable(): void {
		if (this.isEnabled) this.fullscreenRenderer()!.setLayoutRoot(this.originalRoot);
		this.originalRoot = undefined;
		this.splitRoot = undefined;
		this.split = undefined;
		this.rightScroll = undefined;
	}

	setLive(message?: ConversationMessage): void {
		this.messages.setLive(message);
		if (this.isEnabled) this.tui.requestRender();
	}

	refresh(): void {
		this.messages.invalidate();
		if (this.isEnabled) this.tui.requestRender();
	}

	scroll(direction: "up" | "down" | "end"): void {
		if (!this.isEnabled || !this.rightScroll) return;
		if (direction === "end") {
			this.rightScroll.scrollToEnd();
		} else {
			const page = Math.max(1, this.rightScroll.viewportHeight - 2);
			this.rightScroll.scrollBy(direction === "up" ? -page : page);
		}
		this.tui.requestRender();
	}

	get isEditorFocused(): boolean {
		const editorContainer = this.tui.children[4];
		const focused = this.fullscreenRenderer()?.getFocusedComponent() ?? null;
		return editorContainer instanceof Container && focused !== null && editorContainer.children.includes(focused);
	}
}
