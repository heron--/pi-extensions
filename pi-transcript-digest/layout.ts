import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, HStack, ScrollView, VStack, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
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

/*
 * Frame cost. pi-tui composites every box that does not start at column 0 and
 * span the full width into its row. Compositing segments the row into
 * graphemes, which costs about a microsecond per cell, and pi-tui's scrollbar
 * painter rescans the whole row three times per scrollbar cell. A split row
 * therefore cannot use the free full-width path that Pi's own transcript gets.
 * To keep that cost down, the right column is a single box per row. Its rows
 * carry the divider, the conversation row, and the scrollbar cell already
 * joined, so pi-tui composites each row once and paints no scrollbar of its
 * own. Pi still sees a real ScrollView, so selection, the wheel, and keyboard
 * scrolling work as for any other ScrollView.
 */

type TuiMouseDispatchResult = NonNullable<ReturnType<Container["handleMouse"]>>;

interface Thumb {
	top: number;
	height: number;
	maxScrollTop: number;
}

/** pi-tui's scrollbar geometry, so the right pane looks and drags like Pi's own. */
function scrollbarThumb(scrollTop: number, trackHeight: number, contentHeight: number): Thumb {
	const height = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / Math.max(1, contentHeight))),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const top = maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * (trackHeight - height));
	return { top, height, maxScrollTop };
}

/** Containers report the component that handled an event, with its bounds. */
function handledBy(component: Component, event: TuiMouseEvent, result: TuiMouseEventResult = {}): TuiMouseDispatchResult {
	return {
		...result,
		handled: true,
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/**
 * The split stretches every column to its own height, so a column's natural
 * height is never read. pi-tui still measures it every frame, and measuring a
 * VStack renders every child, here a whole transcript. Columns skip that.
 */
class SplitColumn extends VStack {
	override render(_width: number): string[] {
		return [];
	}
}

/**
 * The conversation rows as painted: the divider, the row without its outer
 * gutter columns, then the scrollbar cell. Only rows inside the viewport are
 * read, and ConversationScroll rewrites all of them once the frame's scroll
 * position is final, so rows outside it may be stale.
 */
class PaintedRows implements Component {
	private readonly messages: ConversationPane;
	private rows: string[] = [];
	private source: readonly string[] = [];
	private width = 0;

	constructor(messages: ConversationPane) {
		this.messages = messages;
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const source = this.messages.render(w);
		if (w !== this.width) {
			this.rows = [];
			this.width = w;
		}
		if (this.rows.length > source.length) this.rows.length = source.length;
		while (this.rows.length < source.length) this.rows.push("");
		this.source = source;
		return this.rows;
	}

	paint(scrollTop: number, viewportHeight: number, divider: string, cell: (offset: number) => string): void {
		const end = Math.min(this.source.length, scrollTop + viewportHeight);
		for (let index = Math.max(0, scrollTop); index < end; index++) {
			const row = this.source[index]!;
			this.rows[index] = this.width < 2 ? row : `${divider}${row.slice(1, -1)}${cell(index - scrollTop)}`;
		}
	}

	invalidate(): void {}
}

/**
 * Paints PaintedRows, while its own render() returns the rows as rendered. pi-tui
 * selects and copies text from that render(), so a selection never includes
 * the divider or scrollbar glyphs.
 */
class ConversationContent extends VStack {
	readonly painted: PaintedRows;
	private readonly messages: ConversationPane;

	constructor(messages: ConversationPane) {
		const painted = new PaintedRows(messages);
		super([{ component: painted, basis: "auto", grow: 0, shrink: 0 }]);
		this.painted = painted;
		this.messages = messages;
	}

	override render(width: number): string[] {
		return this.messages.render(width);
	}

	override invalidate(): void {
		this.messages.invalidate();
		super.invalidate();
	}
}

/**
 * The right pane's ScrollView. It paints and drags its own scrollbar, and
 * highlights the thumb while the pointer is over the bar or holds it, as Pi
 * does for its own scrollbars.
 */
class ConversationScroll extends ScrollView {
	private readonly content: ConversationContent;
	private readonly theme: Theme;
	private contentRows = 0;
	private drag?: { grabOffset: number };
	private hovered = false;
	private pointerOnBar?: { x: number; y: number };

	constructor(content: ConversationContent, theme: Theme) {
		super(content, { follow: "end", overscroll: "contain", scrollbar: "hidden" });
		this.content = content;
		this.theme = theme;
	}

	divider(): string {
		return this.theme.fg("border", "│");
	}

	thumbGlyph(): string {
		return this.theme.fg("scrollbarThumb", this.drag || this.hovered ? "█" : "┃");
	}

	/** Records that the pointer of this motion event is over the scrollbar column. */
	notePointerOnBar(event: TuiMouseEvent): void {
		if (event.type === "move" && event.x === event.width - 1) this.pointerOnBar = { x: event.screenX, y: event.screenY };
	}

	/**
	 * Settles the hover state once every component under the pointer has seen
	 * the event. A motion event that no bar cell noted is off the bar. Returns
	 * whether the highlight changed.
	 */
	settleHover(event: TuiMouseEvent): boolean {
		if (event.type !== "move") return false;
		const onBar = this.pointerOnBar?.x === event.screenX && this.pointerOnBar.y === event.screenY;
		this.pointerOnBar = undefined;
		if (onBar === this.hovered) return false;
		this.hovered = onBar;
		return true;
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		// Layout precedes painting, so the rows written here are the ones this
		// frame paints, at this frame's final scroll position.
		this.contentRows = Math.max(0, Math.floor(contentHeight));
		const trackHeight = this.viewportHeight;
		if (trackHeight <= 0) return;
		const thumb = scrollbarThumb(this.scrollTop, trackHeight, this.contentRows);
		const thumbGlyph = this.thumbGlyph();
		const track = this.theme.fg("scrollbarTrack", "│");
		this.content.painted.paint(this.scrollTop, trackHeight, this.divider(), (offset) =>
			offset >= thumb.top && offset < thumb.top + thumb.height ? thumbGlyph : track);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const trackHeight = this.viewportHeight;
		const onTrack = event.x === event.width - 1 && event.y >= 0 && event.y < trackHeight;
		if (onTrack) this.notePointerOnBar(event);
		if (this.drag) {
			if (event.type === "release") {
				this.drag = undefined;
				this.hovered = onTrack;
				return handledBy(this, event, { render: true });
			}
			if (event.type === "drag") {
				this.scrollToPointer(event.y);
				return handledBy(this, event);
			}
		}
		if (event.type !== "press" || event.button !== "left" || !onTrack) return undefined;
		// Matches pi-tui: grabbing the thumb keeps the pointer's offset in it;
		// pressing the track centres the thumb on the pointer.
		const thumb = scrollbarThumb(this.scrollTop, trackHeight, this.contentRows);
		const onThumb = event.y >= thumb.top && event.y < thumb.top + thumb.height;
		this.drag = { grabOffset: onThumb ? event.y - thumb.top : Math.floor(thumb.height / 2) };
		if (!onThumb) this.scrollToPointer(event.y);
		return handledBy(this, event, { capture: true, render: true });
	}

	private scrollToPointer(y: number): void {
		if (!this.drag) return;
		const trackHeight = this.viewportHeight;
		const thumb = scrollbarThumb(this.scrollTop, trackHeight, this.contentRows);
		const maxThumbTop = trackHeight - thumb.height;
		const thumbTop = Math.max(0, Math.min(maxThumbTop, y - this.drag.grabOffset));
		this.scrollTo(maxThumbTop === 0 ? 0 : Math.round((thumbTop / maxThumbTop) * thumb.maxScrollTop));
	}
}

class RightPane extends SplitColumn {
	private readonly scroll: ScrollView;

	constructor(children: ConstructorParameters<typeof VStack>[0], scroll: ScrollView) {
		super(children);
		this.scroll = scroll;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		// Pi's fullscreen renderer offers each event to every component under
		// the pointer, deepest first, so children have already seen it.
		// Forwarding through Container.handleMouse would render every child
		// again to locate its rows.
		if (event.type !== "wheel") return undefined;
		// Prevent Pi from falling back to the primary (left) transcript at the
		// right pane's scroll limits.
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		return handledBy(this, event);
	}
}

/**
 * Pi offers a pointer event to every component under the pointer, deepest
 * first, until one handles it, so the root sees every motion event that the
 * panes leave unhandled, after they have.
 */
class SplitRoot extends VStack {
	private readonly onPointer: (event: TuiMouseEvent) => void;

	constructor(children: ConstructorParameters<typeof VStack>[0], onPointer: (event: TuiMouseEvent) => void) {
		super(children);
		this.onPointer = onPointer;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		this.onPointer(event);
		return undefined;
	}
}

/** Numeric bases keep the panes equal; HStack's weighted grow is sequential. */
class HalfWidthStack extends HStack {
	setViewportWidth(width: number): void {
		const columns = Math.max(0, Math.floor(width));
		const left = Math.floor(Math.max(0, columns - 1) / 2);
		this.entries[0]!.basis = left;
		this.entries[1]!.basis = columns - left; // the divider and the right pane
	}
}

/** Keeps Pi's original transcript ScrollView and input dock intact. */
export class TranscriptDigestLayout {
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

		const side = new ConversationScroll(new ConversationContent(this.messages), this.theme);
		// Title on the left, session counts right-aligned. Counts that do not fit
		// beside the title wrap onto right-aligned rows below it.
		const header: Component = {
			render: (width) => {
				const w = Math.max(1, width - 1);
				const divider = side.divider();
				if (w < 3) return [`${divider}${" ".repeat(w)}`];
				const innerWidth = w - 2;
				const title = truncateToWidth(this.theme.fg("muted", this.theme.bold("Transcript Digest")), innerWidth, "");
				const stats = this.messages.getStats();
				const parts = [
					`${stats.userMessages} User Messages`,
					`${stats.agentMessages} Agent Messages`,
					`${stats.toolCalls} Tool Calls`,
					`${stats.thinkingBlocks} Thinking Blocks`,
				];
				const rows: string[] = [];
				let rowWidth = innerWidth - visibleWidth(title) - 2;
				let current = "";
				for (const part of parts) {
					const combined = current ? `${current} · ${part}` : part;
					if (visibleWidth(combined) <= rowWidth) {
						current = combined;
						continue;
					}
					rows.push(current);
					rowWidth = innerWidth;
					current = part;
				}
				rows.push(current);
				return rows.map((text, index) => {
					const left = index === 0 ? title : "";
					const clipped = truncateToWidth(this.theme.fg("muted", text), innerWidth - visibleWidth(left), "");
					const gap = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(clipped));
					return `${divider} ${left}${" ".repeat(gap)}${clipped} `;
				});
			},
			invalidate: () => {},
		};
		// Continues the divider and scrollbar below a conversation shorter than
		// the pane. The scrollbar is then all thumb, as for a ScrollView whose
		// content fits.
		const filler: Component = {
			render: (width) => {
				const row = `${side.divider()}${" ".repeat(Math.max(0, width - 2))}${width > 1 ? side.thumbGlyph() : ""}`;
				return Array.from({ length: Math.max(1, renderer.terminal.rows) }, () => row);
			},
			handleMouse: (event) => {
				side.notePointerOnBar(event);
				return undefined;
			},
			invalidate: () => {},
		};
		const right = new RightPane([
			{ component: header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
			{ component: side, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			{ component: filler, basis: 0, grow: 1, shrink: 0, minSize: 0 },
		], side);
		const splitVisible = ({ width }: { width: number }) => width >= MIN_SPLIT_COLUMNS;
		const split = new HalfWidthStack([
			{ component: new SplitColumn([{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }]), basis: 0, grow: 1, minSize: 1 },
			{ component: right, basis: 0, grow: 0, minSize: 1, visible: splitVisible },
		]);
		split.setViewportWidth(renderer.terminal.columns);
		// The fullscreen dock keeps its original components, widths, focus, and
		// vertical sizing. Only the transcript slot becomes two columns.
		const splitRoot = new SplitRoot([
			{ component: split, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		], (event) => {
			if (side.settleHover(event)) renderer.requestRender();
		});
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

	setAgentRunning(running: boolean): void {
		this.messages.setAgentRunning(running);
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
