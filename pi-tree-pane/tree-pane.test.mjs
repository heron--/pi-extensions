import assert from "node:assert/strict";
import test from "node:test";
import { Container, HStack, ScrollView, TuiAltScreen, VStack, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import treePaneExtension from "./index.ts";
import { TreePaneLayout, MIN_SPLIT_COLUMNS } from "./layout.ts";
import { ConversationPane, conversationItem, conversationItems } from "./messages.ts";

const theme = {
	fg(color, text) {
		const code = { accent: 35, success: 32, muted: 90, dim: 90, border: 90 }[color] ?? 39;
		return `\x1b[${code}m${text}\x1b[0m`;
	},
	bold(text) { return `\x1b[1m${text}\x1b[22m`; },
	italic(text) { return `\x1b[3m${text}\x1b[23m`; },
};

function user(text) { return { role: "user", content: text, timestamp: 1 }; }
function assistant(content) { return { role: "assistant", content, timestamp: 2 }; }
function entry(id, message) { return { type: "message", id, message }; }

function session(entries = []) {
	return {
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => entries,
	};
}

test("the slash command is /tree-pane and its usage matches", async () => {
	const commands = new Map();
	treePaneExtension({
		on() {},
		registerCommand(name, command) { commands.set(name, command); },
	});
	assert.deepEqual([...commands.keys()], ["tree-pane"]);
	const notices = [];
	const ctx = { ui: { notify(message, level) { notices.push({ message, level }); } } };
	await commands.get("tree-pane").handler("invalid", ctx);
	assert.deepEqual(notices, [{ message: "Usage: /tree-pane [on|off|status]", level: "warning" }]);
});

test("conversation shows user and assistant text with summaries for hidden activity", () => {
	const withImage = {
		role: "user",
		content: [{ type: "text", text: "look\x1b[2J\tat" }, { type: "image", data: "...", mimeType: "image/png" }],
		timestamp: 1,
	};
	assert.deepEqual(conversationItem(withImage), { role: "user", text: "look    at\n[image]", timestamp: 1 });
	assert.deepEqual(conversationItem(assistant([
		{ type: "thinking", thinking: "internal" },
		{ type: "text", text: "answer\nline two" },
		{ type: "toolCall", id: "t", name: "bash", arguments: { command: "ls" } },
	])), { role: "assistant", text: "answer\nline two", timestamp: 2 });
	assert.equal(conversationItem(assistant([{ type: "toolCall", id: "t", name: "bash", arguments: {} }])), undefined);
	assert.equal(conversationItem({ role: "custom", customType: "pi-recap", content: "recap", display: true }), undefined);

	const first = user("hello");
	const streamed = assistant([{ type: "text", text: "partial" }]);
	const entries = [entry("1", first), entry("2", assistant([{ type: "toolCall", id: "t", name: "bash", arguments: {} }])),
		{ type: "custom", customType: "pi-recap", data: {} },
		entry("3", { role: "toolResult", content: [{ type: "text", text: "tool output" }] })];
	assert.deepEqual(conversationItems(entries, streamed), [
		{ role: "user", text: "hello", timestamp: 1 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0 },
		{ role: "assistant", text: "partial", timestamp: 2 },
	]);
	entries.push(entry("4", streamed));
	assert.equal(conversationItems(entries, streamed).length, 3, "the persisted live message appears once");
});

test("assistant labels show the model stored on each response and omit missing models", () => {
	const first = { ...assistant([{ type: "text", text: "first" }]), timestamp: undefined, model: "request-alias", responseModel: "served-model-a" };
	const second = { ...assistant([{ type: "text", text: "second" }]), timestamp: undefined, model: "model-b" };
	const missing = { ...assistant([{ type: "text", text: "third" }]), timestamp: undefined, model: "  " };
	const entries = [entry("1", first), entry("2", second), entry("3", missing)];
	assert.deepEqual(conversationItem(first), {
		role: "assistant", text: "first", timestamp: undefined, model: "served-model-a",
	});

	const pane = new ConversationPane(session(entries), theme);
	const labels = (width) => pane.render(width).map(stripTerminalSequences).map((line) => line.trim()).filter((line) => line.startsWith("Assistant"));
	assert.deepEqual(labels(80), ["Assistant (served-model-a)", "Assistant (model-b)", "Assistant"]);
	assert(!labels(80).some((line) => line.includes("request-alias")), "the recorded response model takes precedence");
	for (const width of [18, 24, 32]) {
		const lines = pane.render(width);
		assert(lines.every((line) => visibleWidth(line) === width));
		assert(lines.map(stripTerminalSequences).join("").replace(/\s/g, "").includes("served-model-a"));
	}
	assert(pane.render(80).some((line) => line.includes("\x1b[90m(served-model-a)")), "model ids are dimmed");

	const livePane = new ConversationPane(session(), theme);
	livePane.setLive({ ...assistant([{ type: "text", text: "streaming" }]), timestamp: undefined, model: "live-model" });
	assert(livePane.render(80).map(stripTerminalSequences).map((line) => line.trim()).includes("Assistant (live-model)"));
});

test("activity summaries count thinking blocks and tool calls between visible messages", () => {
	const toolCall = { type: "toolCall", id: "t", name: "bash", arguments: {} };
	const thinking = { type: "thinking", thinking: "hidden reasoning" };
	const entries = [
		entry("1", user("question")),
		entry("2", assistant([thinking, toolCall])),
		entry("3", { role: "toolResult", content: [{ type: "text", text: "tool output" }] }),
		entry("4", assistant([{ type: "thinking", thinking: "more reasoning" }, { type: "text", text: "answer" }])),
	];
	assert.deepEqual(conversationItems(entries), [
		{ role: "user", text: "question", timestamp: 1 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 2 },
		{ role: "assistant", text: "answer", timestamp: 2 },
	]);

	const trailing = new ConversationPane(session(entries.slice(0, 3)), theme).render(18);
	assert(trailing.every((line) => visibleWidth(line) === 18));
	assert(trailing.map(stripTerminalSequences).map((line) => line.trim()).join(" ").includes("1 tool call, 1 thinking block"));
});

test("live activity summaries update as thinking blocks and tool calls arrive", () => {
	const pane = new ConversationPane(session([entry("1", user("question"))]), theme);
	const live = assistant([]);
	const plainLines = () => pane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	pane.setLive(live);
	assert(!plainLines().some((line) => line.includes("tool call")));

	live.content = [{ type: "thinking", thinking: "reasoning" }];
	pane.setLive(live);
	let lines = pane.render(64);
	assert(plainLines().includes("0 tool calls, 1 thinking block"));
	const summary = lines.find((line) => stripTerminalSequences(line).includes("0 tool calls, 1 thinking block"));
	assert(summary?.includes("\x1b[3m"), "activity summaries are italic");
	assert(summary?.includes("\x1b[90m"), "activity summaries use the dim color");

	live.content.push({ type: "toolCall", id: "t", name: "bash", arguments: {} });
	pane.setLive(live);
	assert(plainLines().includes("1 tool call, 1 thinking block"));

	live.content.push({ type: "text", text: "answer" });
	pane.setLive(live);
	lines = pane.render(64);
	const plain = lines.map(stripTerminalSequences).map((line) => line.trim());
	const activityIndex = plain.indexOf("1 tool call, 1 thinking block");
	assert(activityIndex > plain.indexOf("question"));
	assert(activityIndex < plain.findIndex((line) => line.startsWith("Assistant")), "the live summary stays between visible messages");
	assert(lines.every((line) => visibleWidth(line) === 64));
});

test("persisted live activity is not counted twice", () => {
	const entries = [entry("1", user("question"))];
	const live = assistant([
		{ type: "thinking", thinking: "reasoning" },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const pane = new ConversationPane(session(entries), theme);
	const summaryCount = () => pane.render(64).map(stripTerminalSequences).join("\n").match(/1 tool call, 1 thinking block/g)?.length ?? 0;

	pane.setLive(live);
	assert.equal(summaryCount(), 1);
	entries.push(entry("2", live));
	pane.setLive(live);
	assert.equal(summaryCount(), 1);
});

test("activity summaries follow text that precedes tool calls in persisted and live messages", () => {
	const first = assistant([
		{ type: "text", text: "I'll check that." },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const answer = assistant([{ type: "text", text: "Done." }]);
	const entries = [
		entry("1", user("question")),
		entry("2", first),
		entry("3", { role: "toolResult", content: [{ type: "text", text: "tool output" }] }),
		entry("4", answer),
	];
	assert.deepEqual(conversationItems(entries), [
		{ role: "user", text: "question", timestamp: 1 },
		{ role: "assistant", text: "I'll check that.", timestamp: 2 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0 },
		{ role: "assistant", text: "Done.", timestamp: 2 },
	]);

	const pane = new ConversationPane(session(entries), theme);
	const persisted = pane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	assert(persisted.indexOf("I'll check that.") < persisted.indexOf("1 tool call, 0 thinking blocks"));
	assert(persisted.indexOf("1 tool call, 0 thinking blocks") < persisted.indexOf("Done."));

	const livePane = new ConversationPane(session([entry("1", user("question"))]), theme);
	const live = assistant([
		{ type: "text", text: "I'll check that." },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const liveLines = () => livePane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	livePane.setLive(live);
	let current = liveLines();
	assert(current.indexOf("I'll check that.") < current.indexOf("1 tool call, 0 thinking blocks"));

	live.content.push({ type: "text", text: "Done." });
	livePane.setLive(live);
	current = liveLines();
	assert(current.indexOf("I'll check that.") < current.indexOf("1 tool call, 0 thinking blocks"));
	assert(current.indexOf("1 tool call, 0 thinking blocks") < current.indexOf("Done."));
});

test("streaming reuses rendered history until the branch, width, or theme changes", () => {
	const entries = [entry("1", user("history"))];
	let branchReads = 0;
	let historyLabelRenders = 0;
	const countingTheme = {
		...theme,
		fg(color, text) {
			if (color === "accent" && text.includes("User")) historyLabelRenders++;
			return theme.fg(color, text);
		},
	};
	const pane = new ConversationPane({
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => { branchReads++; return entries; },
	}, countingTheme);
	const history = pane.render(32);
	assert.equal(branchReads, 1);
	assert.equal(historyLabelRenders, 1);

	const live = assistant([{ type: "text", text: "chunk 0" }]);
	for (let index = 0; index < 12; index++) {
		live.content = [{ type: "text", text: `chunk ${index}` }];
		pane.setLive(live);
		const lines = pane.render(32);
		assert.deepEqual(lines.slice(0, history.length), history);
		assert(lines.some((line) => line.includes(`chunk ${index}`)));
		assert.equal(branchReads, 1, "stream updates do not re-read the branch");
		assert.equal(historyLabelRenders, 1, "stream updates do not re-render history");
	}

	entries.push(entry("2", live));
	const finalized = pane.render(32);
	assert.equal(branchReads, 2, "a new leaf refreshes the history");
	assert.equal(historyLabelRenders, 2);
	assert.equal(finalized.filter((line) => line.includes("chunk 11")).length, 1, "persisted live messages appear once");
	pane.setLive(undefined);
	assert.equal(pane.render(32).filter((line) => line.includes("chunk 11")).length, 1);
	pane.render(18);
	assert.equal(branchReads, 3, "a new width rewraps history");
	assert.equal(historyLabelRenders, 3);
	pane.invalidate();
	pane.render(18);
	assert.equal(branchReads, 4, "theme/session invalidation rebuilds history");
	assert.equal(historyLabelRenders, 4);
});

test("live text replaces the empty-state hint without rebuilding an empty branch", () => {
	let branchReads = 0;
	const pane = new ConversationPane({
		getLeafId: () => null,
		getBranch: () => { branchReads++; return []; },
	}, theme);
	assert(pane.render(24)[0].includes("No messages yet"));
	pane.setLive(assistant([{ type: "text", text: "partial" }]));
	assert(!pane.render(24).some((line) => line.includes("No messages yet")));
	pane.setLive(undefined);
	assert(pane.render(24)[0].includes("No messages yet"));
	assert.equal(branchReads, 1);
});

test("labels show the message's local date and time across days and streaming updates", () => {
	const first = { ...user("hello"), timestamp: new Date(2025, 11, 31, 23, 5).getTime() };
	const reply = { ...assistant([{ type: "text", text: "answer" }]), timestamp: new Date(2026, 0, 1, 14, 32).getTime() };
	const pane = new ConversationPane(session([entry("1", first), entry("2", reply)]), theme);
	const labels = () => pane.render(32).map(stripTerminalSequences).map((line) => line.trim());
	assert(labels().includes("User 2025-12-31 23:05"));
	assert(labels().includes("Assistant 2026-01-01 14:32"));
	assert(pane.render(32).some((line) => line.includes("\x1b[90m2025-12-31 23:05")), "timestamps are dimmed independently of the label");

	const live = { ...reply, content: [{ type: "text", text: "partial" }], timestamp: new Date(2026, 0, 2, 0, 7).getTime() };
	pane.setLive(live);
	assert(labels().includes("Assistant 2026-01-02 00:07"));
	pane.setLive({ ...live, content: [{ type: "text", text: "completed" }] });
	assert(labels().includes("Assistant 2026-01-02 00:07"), "stream updates keep the original message timestamp");
});

test("narrow panes wrap labels and timestamps without dropping the date or time", () => {
	const pane = new ConversationPane(session([
		entry("1", { ...assistant([{ type: "text", text: "answer" }]), timestamp: new Date(2026, 0, 2, 9, 5).getTime() }),
	]), theme);
	for (const width of [17, 18, 24, 32]) {
		const lines = pane.render(width);
		assert(lines.every((line) => visibleWidth(line) === width));
		assert.equal(lines.map(stripTerminalSequences).map((line) => line.trim()).filter(Boolean).join(" "),
			"Assistant 2026-01-02 09:05 answer");
	}
});

test("missing or invalid timestamps leave plain role labels", () => {
	for (const timestamp of [undefined, null, "bad", NaN, Infinity, -Infinity, 8.64e15 + 1]) {
		const pane = new ConversationPane(session([
			entry("1", { ...user("hello"), timestamp }),
			entry("2", { ...assistant([{ type: "text", text: "answer" }]), timestamp }),
		]), theme);
		const lines = pane.render(24).map(stripTerminalSequences).map((line) => line.trim());
		assert.deepEqual(lines, ["", "User", "hello", "", "Assistant", "answer"]);
	}
});

test("pane wraps long words, lines and wide graphemes within its width", () => {
	const entries = [entry("1", user("one long examplewithnobreaksinthemiddlebutplentyofletters 中文🙂\nnew line")),
		entry("2", assistant([{ type: "text", text: "reply" }]))];
	const pane = new ConversationPane(session(entries), theme);
	const lines = pane.render(18);
	assert(lines.length > 9);
	assert(lines.every((line) => visibleWidth(line) === 18));
	assert(lines.some((line) => line.includes("\x1b[35m") && line.includes("User")));
	assert(lines.some((line) => line.includes("\x1b[32m") && line.includes("Assistant")));
	assert(lines.some((line) => line.includes("new line")));
	assert.equal(pane.render(18), lines, "an unchanged branch reuses wrapped output");
	pane.invalidate();
	assert.notEqual(pane.render(18), lines, "theme changes discard styled rows");
	assert(pane.render(3).every((line) => visibleWidth(line) <= 3));
});

test("layout keeps Pi's transcript and dock, splits evenly and restores the original root", () => {
	const document = { render: (width) => ["L".repeat(width)], invalidate() {} };
	const transcript = new ScrollView(document, { primary: true, follow: "end" });
	const editor = { render: () => [">"], invalidate() {} };
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const dock = new VStack([editorContainer]);
	const originalRoot = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const tui = {
		mode: "fullscreen", layoutRoot: originalRoot, terminal: { columns: 81, rows: 24 },
		children: [document, undefined, undefined, undefined, editorContainer], renders: 0,
		setLayoutRoot(root) { this.layoutRoot = root; this.renders++; },
		requestRender() { this.renders++; },
		getFocusedComponent() { return editor; },
	};
	const pane = new ConversationPane(session([entry("1", user("hello"))]), theme);
	const layout = new TreePaneLayout(tui, theme, pane);
	assert.equal(layout.enable(), "enabled");
	assert.equal(layout.isEnabled, true);
	assert.equal(layout.isEditorFocused, true);
	assert.equal(layout.enable(), "enabled", "enable is idempotent");
	const split = tui.layoutRoot.children[0];
	assert(split instanceof HStack);
	assert.equal(split.children[0], transcript, "left pane is Pi's original transcript");
	assert.equal(tui.layoutRoot.children[1], dock, "the input dock is unchanged");
	const right = split.children[2];
	assert(right instanceof VStack);
	const side = right.children[1];
	assert(side instanceof ScrollView);
	assert.equal(side.scrollbar, "always");
	assert.equal(visibleWidth(split.render(81)[0]), 81);
	assert.equal(stripTerminalSequences(split.render(81)[0])[40], "│", "the panes share the available columns equally");
	tui.terminal.columns = 40;
	layout.reconcile();
	assert.equal(stripTerminalSequences(split.render(40)[0])[19], "│", "resize keeps a 50/50 split");
	assert(stripTerminalSequences(split.render(40)[0]).includes("Conversation"));
	assert.equal(visibleWidth(split.render(MIN_SPLIT_COLUMNS - 1)[0]), MIN_SPLIT_COLUMNS - 1);
	tui.terminal.columns = 81;
	layout.reconcile();
	assert.equal(layout.isVisible, true);

	side.updateLayout(60, 10, () => {});
	layout.scroll("up");
	assert.equal(side.scrollTop, 42);
	assert.equal(right.handleMouse({ type: "wheel", wheelDelta: -3 }).handled, true);
	assert.equal(side.scrollTop, 39);
	const click = { type: "click", button: "left", x: 2, y: 2, screenX: 43, screenY: 2, width: 40, height: 23 };
	assert.equal(right.handleMouse(click), undefined, "unhandled clicks remain available to Pi's selection");
	const forwarded = [];
	pane.handleMouse = (event) => { forwarded.push(event); return { handled: true }; };
	if (typeof VStack.prototype.handleMouse === "function") {
		assert.equal(right.handleMouse(click)?.target.component, pane, "nested controls receive non-wheel events");
		assert.equal(forwarded[0].y, 1, "the title's row is excluded from child coordinates");
	} else {
		assert.equal(right.handleMouse(click), undefined, "older renderers leave clicks to Pi");
	}
	layout.scroll("end");
	assert.equal(side.scrollTop, 50);
	layout.disable();
	assert.equal(tui.layoutRoot, originalRoot);
	assert.equal(layout.isEnabled, false);
});

test("fullscreen mouse press and drag scroll the right scrollbar independently", () => {
	const terminal = {
		columns: 81, rows: 24, kittyProtocolActive: false,
		write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	const document = { render: (width) => ["L".repeat(width)], invalidate() {} };
	const transcript = new ScrollView(document, { primary: true, follow: "end" });
	const dock = new VStack([{ render: () => [">"], invalidate() {} }]);
	tui.addChild(document);
	tui.setLayoutRoot(new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]));
	const messages = Array.from({ length: 40 }, (_, index) => entry(String(index + 1), user(`Message ${index + 1}`)));
	const layout = new TreePaneLayout(tui, theme, new ConversationPane(session(messages), theme));
	assert.equal(layout.enable(), "enabled");
	tui.start();
	try {
		tui.renderNow();
		const right = tui.layoutRoot.children[0].children[2];
		const side = right.children[1];
		const atEnd = side.scrollTop;
		assert(atEnd > 0, "conversation exceeds its viewport");
		const x = terminal.columns;
		const thumbY = 1 + side.viewportHeight; // scrollbar thumb ends on the last viewport row
		tui.handleTerminalInput(`\x1b[<0;${x};${thumbY}M`); // press the scrollbar thumb
		tui.handleTerminalInput(`\x1b[<32;${x};4M`); // drag while holding the primary button
		assert(side.scrollTop < atEnd, "drag moves the right pane up");
		const afterDragUp = side.scrollTop;
		tui.handleTerminalInput(`\x1b[<32;${x};${thumbY}M`);
		assert(side.scrollTop > afterDragUp, "drag moves the right pane down");
		tui.handleTerminalInput(`\x1b[<0;${x};${thumbY}m`); // release
		assert.equal(transcript.scrollTop, 0, "the left transcript is not scrolled");
	} finally {
		layout.disable();
		tui.stop({ preserveScreen: true });
	}
});

test("incompatible or regular layouts remain untouched", () => {
	const renderer = {
		mode: "regular", layoutRoot: undefined, children: [], terminal: { columns: 80, rows: 20 },
		setLayoutRoot(root) { this.layoutRoot = root; }, requestRender() {},
	};
	const layout = new TreePaneLayout(renderer, theme, new ConversationPane(session(), theme));
	assert.equal(layout.enable(), "fullscreen-required");
	renderer.mode = "fullscreen";
	renderer.layoutRoot = new Container();
	assert.equal(layout.enable(), "unsupported-layout");
	assert(renderer.layoutRoot instanceof Container);
});
