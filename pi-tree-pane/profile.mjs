import { performance } from "node:perf_hooks";
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { TreePaneLayout } from "./layout.ts";
import { ConversationPane } from "./messages.ts";

const theme = {
	fg(color, text) {
		const code = { success: 32, muted: 90, dim: 90, border: 90, syntaxType: 34, scrollbarTrack: 90, scrollbarThumb: 37 }[color] ?? 39;
		return `\x1b[${code}m${text}\x1b[0m`;
	},
	bold(text) { return `\x1b[1m${text}\x1b[22m`; },
	italic(text) { return `\x1b[3m${text}\x1b[23m`; },
};

function positiveInteger(value, fallback, name) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function messageEntry(index) {
	const role = index % 2 === 0 ? "user" : "assistant";
	const text = `message ${index} ${"representative conversation text ".repeat(5)}`;
	const message = role === "user"
		? { role, content: text, timestamp: index }
		: { role, content: [{ type: "text", text }], timestamp: index, model: "profile-model" };
	return { type: "message", id: String(index), message };
}

function createEntries(count) {
	return Array.from({ length: count }, (_, index) => messageEntry(index));
}

function createSession(entries) {
	return {
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => entries,
	};
}

function profileAppend(args) {
	const initialMessages = positiveInteger(args[0], 2000, "initialMessages");
	const appendedMessages = positiveInteger(args[1], 200, "appendedMessages");
	const width = positiveInteger(args[2], 59, "width");
	const entries = createEntries(initialMessages);
	const pane = new ConversationPane(createSession(entries), theme);
	pane.render(width);
	pane.getStats();
	const startedAt = performance.now();
	for (let index = 0; index < appendedMessages; index++) {
		entries.push(messageEntry(initialMessages + index));
		pane.render(width);
		pane.getStats();
	}
	const elapsedMs = performance.now() - startedAt;
	console.log(JSON.stringify({
		scenario: "append",
		initialMessages,
		appendedMessages,
		width,
		elapsedMs,
		msPerAppend: elapsedMs / appendedMessages,
	}));
}

function profileScroll(args) {
	const variant = args[0] ?? "split";
	if (variant !== "split" && variant !== "baseline") throw new Error("scroll variant must be split or baseline");
	const messageCount = positiveInteger(args[1], 2000, "messageCount");
	const frames = positiveInteger(args[2], 500, "frames");
	const columns = positiveInteger(args[3], 120, "columns");
	const rows = positiveInteger(args[4], 40, "rows");
	const entries = createEntries(messageCount);
	const document = new Container();
	for (const entry of entries) {
		const content = entry.message.role === "user" ? entry.message.content : entry.message.content[0].text;
		document.addChild(new Text(`${entry.message.role}\n${content}`, 0, 0));
	}
	const transcript = new ScrollView(document, { primary: true, follow: "end" });
	const editor = { render: () => [">"], invalidate() {} };
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const dock = new VStack([editorContainer]);
	const originalRoot = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const terminal = {
		columns,
		rows,
		kittyProtocolActive: false,
		write() {},
		start() {},
		stop() {},
		hideCursor() {},
		showCursor() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	tui.addChild(document);
	tui.addChild({ render: () => [], invalidate() {} });
	tui.addChild({ render: () => [], invalidate() {} });
	tui.addChild({ render: () => [], invalidate() {} });
	tui.addChild(editorContainer);
	tui.setLayoutRoot(originalRoot);
	const layout = new TreePaneLayout(tui, theme, new ConversationPane(createSession(entries), theme));
	if (variant === "split" && layout.enable() !== "enabled") throw new Error("could not enable split layout");
	tui.start();
	try {
		tui.renderNow();
		const scroll = variant === "split" ? tui.layoutRoot.children[0].children[2].children[1] : transcript;
		scroll.scrollToStart();
		tui.renderNow();
		const startedAt = performance.now();
		for (let frame = 0; frame < frames; frame++) {
			scroll.scrollBy(frame % 2 === 0 ? 1 : -1);
			tui.renderNow();
		}
		const elapsedMs = performance.now() - startedAt;
		console.log(JSON.stringify({
			scenario: "scroll",
			variant,
			messageCount,
			frames,
			columns,
			rows,
			elapsedMs,
			msPerFrame: elapsedMs / frames,
		}));
	} finally {
		layout.disable();
		tui.stop({ preserveScreen: true });
	}
}

const [scenario = "append", ...args] = process.argv.slice(2);
if (scenario === "append") profileAppend(args);
else if (scenario === "scroll") profileScroll(args);
else throw new Error("scenario must be append or scroll");
