import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, HStack, Markdown, ScrollView, TuiAltScreen, VStack, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import transcriptDigestExtension from "./index.ts";
import { TranscriptDigestLayout, MIN_SPLIT_COLUMNS } from "./layout.ts";
import { ConversationPane, conversationItem, conversationItems, formatElapsed } from "./messages.ts";

initTheme("dark");

const theme = {
	fg(color, text) {
		const code = { accent: 35, success: 32, warning: 33, muted: 90, dim: 90, border: 90, syntaxType: 34 }[color] ?? 39;
		return `\x1b[${code}m${text}\x1b[0m`;
	},
	bold(text) { return `\x1b[1m${text}\x1b[22m`; },
	italic(text) { return `\x1b[3m${text}\x1b[23m`; },
};

function user(text) { return { role: "user", content: text, timestamp: 1 }; }
function assistant(content) { return { role: "assistant", content, timestamp: 2 }; }
function entry(id, message) { return { type: "message", id, message }; }
function getEntry(entries, id) {
	const index = entries.findIndex((item) => item.id === id);
	return index < 0 ? undefined : { ...entries[index], parentId: entries[index].parentId ?? entries[index - 1]?.id ?? null };
}

function session(entries = []) {
	return {
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry: (id) => getEntry(entries, id),
		getBranch: () => entries,
	};
}

test("the slash command is /transcript-digest and its usage matches", async () => {
	const commands = new Map();
	transcriptDigestExtension({
		on() {},
		registerCommand(name, command) { commands.set(name, command); },
	});
	assert.deepEqual([...commands.keys()], ["transcript-digest"]);
	const notices = [];
	const ctx = { ui: { notify(message, level) { notices.push({ message, level }); } } };
	await commands.get("transcript-digest").handler("invalid", ctx);
	assert.deepEqual(notices, [{ message: "Usage: /transcript-digest [on|off|status]", level: "warning" }]);
});

test("conversation shows user and agent text with summaries for hidden activity", () => {
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
		{ role: "agent-start", timestamp: 2 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0 },
		{ role: "assistant", text: "partial", timestamp: 2 },
	]);
	entries.push(entry("4", streamed));
	assert.equal(conversationItems(entries, streamed).length, 4, "the persisted live message appears once");
});

const markdownSample = [
	"# Heading",
	"",
	"**bold** *italic* ~~removed~~ `inline` [Docs](https://example.com/docs)",
	"",
	"- first",
	"- second",
	"",
	"> quoted",
	"",
	"```ts",
	'const answer = "中文🙂 examplewithnobreaksinthemiddlebutplentyofletters";',
	"```",
	"",
	"| Name | State |",
	"| --- | --- |",
	"| digest | ready |",
].join("\n");

test("user and agent bodies use Pi Markdown while labels and gutters stay separate", () => {
	for (const message of [user(markdownSample), assistant([{ type: "text", text: markdownSample }])]) {
		const pane = new ConversationPane(session([entry("1", { ...message, timestamp: undefined })]), theme);
		pane.setAgentRunning(true);
		const bodyStart = message.role === "user" ? 3 : 4;
		for (const width of [18, 24, 40, 80]) {
			const lines = pane.render(width);
			const body = lines.slice(bodyStart);
			const expected = new Markdown(markdownSample, 0, 0, getMarkdownTheme()).render(width - 4);
			assert.deepEqual(body.map((row) => row.slice(2, -2)), expected, "Markdown receives only the body width");
			assert(lines.every((row) => visibleWidth(row) === width));
			assert(lines.every((row) => row.startsWith("  ") && row.endsWith("  ")), "painted gutters stay outside styled text");
			assert.equal(stripTerminalSequences(lines[1]).trim(), message.role === "user" ? "User" : "Agent");
		}
		const body = pane.render(80).slice(bodyStart).join("\n");
		const plain = stripTerminalSequences(body);
		assert(plain.includes("Heading") && !plain.includes("# Heading"));
		assert(plain.includes("bold italic removed inline Docs") && !plain.includes("**bold**"));
		assert(body.includes(getMarkdownTheme().code("inline")), "inline code uses the active Markdown theme");
		assert(plain.includes("│ quoted") && plain.includes("┌"), "quotes and tables are rendered");
		assert(plain.includes("const answer") && plain.includes("中文🙂"), "code content survives rendering");
	}
});

test("streamed Markdown reuses history and settles into persisted output without duplication", () => {
	const entries = [entry("1", user("**history**"))];
	const pane = new ConversationPane(session(entries), theme);
	const render = Markdown.prototype.render;
	let markdownRenders = 0;
	Markdown.prototype.render = function (width) {
		markdownRenders++;
		return render.call(this, width);
	};
	try {
		const history = [...pane.render(40)];
		const live = assistant([]);
		for (const text of ["**par", "**partial**", "**partial**\n\n```ts\nconst value = 1;", "**partial**\n\n```ts\nconst value = 1;\n```\n\nDone."]) {
			live.content = [{ type: "text", text }];
			pane.setLive(live);
			const before = markdownRenders;
			const rows = pane.render(40);
			assert.deepEqual(rows.slice(0, history.length), history);
			assert(rows.every((row) => visibleWidth(row) === 40));
			assert.equal(markdownRenders, before + 1, "streaming renders only the live body");
			assert.equal(pane.render(40), rows);
			assert.equal(markdownRenders, before + 1, "unchanged frames reuse rendered Markdown");
		}
		const streamed = [...pane.render(40)];
		entries.push(entry("2", live));
		assert.deepEqual(pane.render(40), streamed);
		pane.setLive(undefined);
		assert.deepEqual(pane.render(40), streamed);
		assert.equal(pane.render(40).filter((row) => stripTerminalSequences(row).includes("Done.")).length, 1);
	} finally {
		Markdown.prototype.render = render;
	}
});

test("invalidating the pane refreshes Markdown colors from the active theme", () => {
	const pane = new ConversationPane(session([entry("1", user(markdownSample))]), theme);
	const dark = [...pane.render(60)];
	try {
		initTheme("light");
		pane.invalidate();
		const light = pane.render(60);
		assert.notDeepEqual(light, dark);
		assert.deepEqual(light.map(stripTerminalSequences), dark.map(stripTerminalSequences));
	} finally {
		initTheme("dark");
	}
});

test("agent sections show their first stored model and timestamp in the agent color", () => {
	const firstTimestamp = new Date(2026, 0, 2, 9, 5).getTime();
	const secondTimestamp = new Date(2026, 0, 3, 10, 15).getTime();
	const first = { ...assistant([{ type: "text", text: "first" }]), timestamp: firstTimestamp, model: "request-alias", responseModel: "served-model-a" };
	const second = { ...assistant([{ type: "text", text: "second" }]), timestamp: secondTimestamp, model: "model-b" };
	const missing = { ...assistant([{ type: "text", text: "third" }]), timestamp: undefined, model: "  " };
	const entries = [entry("1", first), entry("2", second), entry("3", missing)];
	assert.deepEqual(conversationItem(first), {
		role: "assistant", text: "first", timestamp: firstTimestamp, model: "served-model-a",
	});

	const pane = new ConversationPane(session(entries), theme);
	const labels = (width) => pane.render(width).map(stripTerminalSequences).map((line) => line.trim()).filter((line) => /^Agent(?: \(| \d|$)/.test(line));
	assert.deepEqual(labels(80), ["Agent (served-model-a) 2026-01-02 09:05"]);
	assert(!pane.render(80).map(stripTerminalSequences).some((line) => line.includes("(2026-01-03 10:15)")), "later messages do not get standalone timestamps");
	assert(!labels(80).some((line) => line.includes("request-alias")), "the recorded response model takes precedence");
	for (const width of [18, 24, 32]) {
		const lines = pane.render(width);
		assert(lines.every((line) => visibleWidth(line) === width));
		assert(lines.map(stripTerminalSequences).join("").replace(/\s/g, "").includes("served-model-a"));
	}
	const firstHeader = pane.render(80).find((line) => stripTerminalSequences(line).includes("(served-model-a)"));
	assert(firstHeader?.includes("\x1b[33m(served-model-a)\x1b[0m"), "model ids use the yellow agent label color");
	assert(firstHeader?.includes("\x1b[90m2026-01-02 09:05\x1b[0m"), "timestamps remain dim");

	const livePane = new ConversationPane(session(), theme);
	livePane.setLive({ ...assistant([{ type: "text", text: "streaming" }]), timestamp: undefined, model: "live-model" });
	assert(livePane.render(80).map(stripTerminalSequences).map((line) => line.trim()).includes("Agent (live-model)"));
});

test("conversation stats count user and agent messages, tool calls, and thinking blocks", () => {
	const firstUser = user("question");
	const toolUse = assistant([
		{ type: "thinking", thinking: "reasoning" },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const finalReply = assistant([{ type: "text", text: "answer" }]);
	const secondUser = user("follow-up");
	const entries = [entry("1", firstUser), entry("2", toolUse), entry("3", finalReply), entry("4", secondUser)];
	const pane = new ConversationPane(session(entries), theme);
	assert.deepEqual(pane.getStats(), { userMessages: 2, agentMessages: 1, toolCalls: 1, thinkingBlocks: 1 }, "tool-only replies are not agent messages");

	const live = assistant([{ type: "text", text: "partial" }]);
	pane.setLive(live);
	assert.deepEqual(pane.getStats(), { userMessages: 2, agentMessages: 2, toolCalls: 1, thinkingBlocks: 1 });
	live.content.push({ type: "thinking", thinking: "more" }, { type: "toolCall", id: "t2", name: "read", arguments: {} });
	pane.setLive(live);
	assert.deepEqual(pane.getStats(), { userMessages: 2, agentMessages: 2, toolCalls: 2, thinkingBlocks: 2 });
	live.content.push({ type: "text", text: "done" });
	pane.setLive(live);
	assert.deepEqual(pane.getStats(), { userMessages: 2, agentMessages: 3, toolCalls: 2, thinkingBlocks: 2 }, "text split by a tool call is two entries");
	entries.push(entry("5", live));
	assert.deepEqual(pane.getStats(), { userMessages: 2, agentMessages: 3, toolCalls: 2, thinkingBlocks: 2 }, "persisting live replies does not double count them");
	const listed = conversationItems(entries).filter((item) => item.role === "assistant").length;
	assert.equal(pane.getStats().agentMessages, listed, "the count matches the agent entries the digest lists");
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
		{ role: "agent-start", timestamp: 2 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 2 },
		{ role: "assistant", text: "answer", timestamp: 2 },
	]);

	const trailing = new ConversationPane(session(entries.slice(0, 3)), theme).render(18);
	assert(trailing.every((line) => visibleWidth(line) === 18));
	assert(trailing.map(stripTerminalSequences).map((line) => line.trim()).join(" ").includes("1 tool call, 1 thinking block"));
});

test("live activity summaries update as thinking blocks and tool calls arrive", () => {
	const pane = new ConversationPane(session([entry("1", user("question"))]), theme);
	pane.setAgentRunning(true);
	const live = assistant([]);
	const plainLines = () => pane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	pane.setLive(live);
	assert(!plainLines().some((line) => line.includes("tool call")));

	live.content = [{ type: "thinking", thinking: "reasoning" }];
	pane.setLive(live);
	let lines = pane.render(64);
	assert(plainLines().includes("0 tool calls, 1 thinking block"));
	const summary = lines.find((line) => stripTerminalSequences(line).includes("0 tool calls, 1 thinking block"));
	assert(summary?.includes(theme.fg("success", theme.italic("0 tool calls"))), "only the tool-call count uses green");
	assert(summary?.includes(theme.fg("dim", theme.italic(", 1 thinking block"))), "the separator and thinking count remain subdued");

	live.content.push({ type: "toolCall", id: "t", name: "bash", arguments: {} });
	pane.setLive(live);
	assert(plainLines().includes("1 tool call, 1 thinking block"));
	const updated = pane.render(64).find((line) => stripTerminalSequences(line).includes("1 tool call, 1 thinking block"));
	assert(updated?.includes(theme.fg("success", theme.italic("1 tool call"))));
	assert(updated?.includes(theme.fg("dim", theme.italic(", 1 thinking block"))));

	live.content.push({ type: "text", text: "answer" });
	pane.setLive(live);
	lines = pane.render(64);
	const plain = lines.map(stripTerminalSequences).map((line) => line.trim());
	const activityIndex = plain.indexOf("1 tool call, 1 thinking block");
	assert(activityIndex > plain.indexOf("question"));
	assert(plain.slice(0, activityIndex).findLast((line) => /^(User|Agent)(?: |$)/.test(line))?.startsWith("Agent"), "live activity belongs to the agent");
	assert(activityIndex < plain.indexOf("answer"), "the live summary precedes the following agent text");
	assert(lines.every((line) => visibleWidth(line) === 64));
});

test("activity-only turns have an Agent header through streaming, persistence, and appended turns", () => {
	const entries = [entry("1", user("question"))];
	const pane = new ConversationPane(session(entries), theme);
	const live = assistant([
		{ type: "thinking", thinking: "hidden" },
		{ type: "toolCall", id: "t", name: "read", arguments: {} },
	]);
	const verify = (expectedHeaders) => {
		const rows = pane.render(64);
		const plain = rows.map((line) => stripTerminalSequences(line).trim());
		assert.equal(plain.filter((line) => /^Agent(?: |$)/.test(line)).length, expectedHeaders);
		for (const [index, line] of plain.entries()) {
			if (!/^\d+ tool calls?/.test(line)) continue;
			const precedingLabel = plain.slice(0, index).findLast((line) => /^(User|Agent)(?: |$)/.test(line));
			assert(precedingLabel?.startsWith("Agent"), "activity is never attributed to User");
		}
		assert(rows.every((line) => visibleWidth(line) === 64));
		return [...rows];
	};
	pane.setAgentRunning(true);
	pane.setLive(live);
	const streamed = verify(1);
	assert(streamed.some((line) => line.includes(theme.fg("warning", theme.bold("Agent")))));
	entries.push(entry("2", live));
	assert.deepEqual(verify(1), streamed, "persisting the live activity keeps one header");
	entries.push(entry("3", { role: "toolResult", content: [] }));
	pane.setLive(undefined);
	assert.deepEqual(verify(1), streamed, "tool results do not duplicate the header");
	entries.push(entry("4", { ...assistant([{ type: "text", text: "answer" }]), stopReason: "stop" }));
	verify(1);
	assert.equal(pane.getStats().agentMessages, 1, "section headers do not change the text-message count");
	entries.push(entry("5", user("follow-up")));
	verify(1);
	entries.push(entry("6", assistant([{ type: "toolCall", id: "t2", name: "read", arguments: {} }])));
	const appended = verify(2);
	pane.invalidate();
	assert.deepEqual(verify(2), appended, "a full rebuild agrees with incremental rendering");

	const activityOnly = new ConversationPane(session([entry("1", live)]), theme);
	assert(activityOnly.render(64).map(stripTerminalSequences).some((line) => line.trim().startsWith("Agent ")), "activity-only sections retain the first message's timestamp");
});

test("message headers have a full-width rule in their role color, including wrapped headers", () => {
	const timestamp = new Date(2026, 0, 2, 9, 5).getTime();
	for (const [message, code, label] of [
		[user("user body"), 34, "User"],
		[{ ...assistant([{ type: "text", text: "agent body" }]), model: "long-model-name-中文🙂" }, 33, "Agent"],
	]) {
		const pane = new ConversationPane(session([entry("1", { ...message, timestamp })]), theme);
		pane.setAgentRunning(true);
		for (const width of [17, 24, 40, 80]) {
			const lines = pane.render(width);
			const plain = lines.map((line) => stripTerminalSequences(line).trim());
			const rules = plain.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
			assert.equal(rules.length, 1, "one rule follows the complete header");
			const ruleIndex = rules[0];
			assert.equal(plain[ruleIndex], "─".repeat(width - 4), "the rule fills the content width");
			assert.equal(lines[ruleIndex], `  \x1b[${code}m${"─".repeat(width - 4)}\x1b[0m  `, "gutters remain outside the colored rule");
			assert(lines[1].includes(`\x1b[${code}m`) && plain[1].startsWith(label));
			assert.equal(plain.slice(1, ruleIndex).join("").replace(/\s/g, ""),
				`${label}${message.model ? `(${message.model})` : ""}2026-01-0209:05`);
			assert.equal(plain.at(-1), message.role === "user" ? "user body" : "agent body");
			if (message.role === "assistant") assert(!plain.slice(ruleIndex + 1).join("").includes("2026-01-02"), "timestamps belong only to the section header");
			assert(lines.every((line) => visibleWidth(line) === width));
		}
	}
});

test("sections have two blank rows between headers, without repeating consecutive Agent headers", () => {
	const pane = new ConversationPane(session([
		entry("1", user("one")),
		entry("2", assistant([{ type: "text", text: "two" }])),
		entry("3", assistant([{ type: "text", text: "three" }])),
	]), theme);
	const lines = pane.render(40).map(stripTerminalSequences).map((line) => line.trim());
	const labels = lines.flatMap((line, index) => line.startsWith("User ") || line.startsWith("Agent ") ? [index] : []);
	assert.equal(labels.length, 2);
	assert(lines.includes("two") && lines.includes("three"));
	for (const index of labels.slice(1)) assert.deepEqual(lines.slice(index - 2, index), ["", ""]);
});

test("persisted live activity is not counted twice", () => {
	const entries = [entry("1", user("question"))];
	const live = assistant([
		{ type: "thinking", thinking: "reasoning" },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const pane = new ConversationPane(session(entries), theme);
	pane.setAgentRunning(true);
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
		{ role: "agent-start", timestamp: 2 },
		{ role: "assistant", text: "I'll check that.", timestamp: 2 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0 },
		{ role: "assistant", text: "Done.", timestamp: 2 },
	]);

	const pane = new ConversationPane(session(entries), theme);
	const persisted = pane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	assert(persisted.indexOf("I'll check that.") < persisted.indexOf("1 tool call, 0 thinking blocks"));
	assert(persisted.indexOf("1 tool call, 0 thinking blocks") < persisted.indexOf("Done."));
	assert.equal(persisted.filter((line) => /^Agent(?: \(| \d|$)/.test(line)).length, 1, "consecutive agent text and activity share one section header");

	const livePane = new ConversationPane(session([entry("1", user("question"))]), theme);
	const live = assistant([
		{ type: "text", text: "I'll check that." },
		{ type: "toolCall", id: "t", name: "bash", arguments: {} },
	]);
	const liveLines = () => livePane.render(64).map(stripTerminalSequences).map((line) => line.trim());
	livePane.setLive(live);
	let current = liveLines();
	assert(current.indexOf("I'll check that.") < current.indexOf("1 tool call, 0 thinking blocks"));
	assert.equal(current.filter((line) => /^Agent(?: |$)/.test(line)).length, 1, "live activity reuses the preceding agent header");

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
			if (color === "syntaxType" && text.includes("User")) historyLabelRenders++;
			return theme.fg(color, text);
		},
	};
	const pane = new ConversationPane({
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry: (id) => getEntry(entries, id),
		getBranch: () => { branchReads++; return entries; },
	}, countingTheme);
	const history = [...pane.render(32)];
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
	assert.equal(branchReads, 1, "a new leaf reads only the appended branch entries");
	assert.equal(historyLabelRenders, 1, "appending a leaf does not re-render existing history");
	assert.equal(finalized.filter((line) => line.includes("chunk 11")).length, 1, "persisted live messages appear once");
	pane.setLive(undefined);
	assert.equal(pane.render(32).filter((line) => line.includes("chunk 11")).length, 1);
	pane.render(18);
	assert.equal(branchReads, 2, "a new width rewraps history");
	assert.equal(historyLabelRenders, 2);
	pane.invalidate();
	pane.render(18);
	assert.equal(branchReads, 3, "theme/session invalidation rebuilds history");
	assert.equal(historyLabelRenders, 3);
});

test("append-only branches render incrementally while branch changes rebuild history", () => {
	const first = entry("1", user("first"));
	let branch = [first];
	let userLabelRenders = 0;
	const countingTheme = {
		...theme,
		fg(color, text) {
			if (color === "syntaxType" && text.includes("User")) userLabelRenders++;
			return theme.fg(color, text);
		},
	};
	const pane = new ConversationPane({
		getLeafId: () => branch.at(-1)?.id ?? null,
		getEntry: (id) => getEntry(branch, id),
		getBranch: () => branch,
	}, countingTheme);
	pane.render(40);
	assert.equal(userLabelRenders, 1);

	branch.push(entry("2", assistant([{ type: "text", text: "reply" }])));
	assert(pane.render(40).some((line) => line.includes("reply")));
	assert.equal(userLabelRenders, 1, "an appended agent message does not re-render the first user");
	branch.push(entry("3", user("second")));
	assert(pane.render(40).some((line) => line.includes("second")));
	assert.equal(userLabelRenders, 2, "only the appended user label renders");

	branch = [first, entry("4", assistant([{ type: "text", text: "alternate" }]))];
	const alternate = pane.render(40);
	assert(alternate.some((line) => line.includes("alternate")));
	assert(!alternate.some((line) => line.includes("second")));
	assert.equal(userLabelRenders, 3, "moving to a different branch rebuilds its history");
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
	assert(labels().includes("Agent 2026-01-01 14:32"));
	assert(pane.render(32).some((line) => line.includes("\x1b[90m2025-12-31 23:05")), "timestamps are dimmed independently of the label");

	const live = { ...reply, content: [{ type: "text", text: "partial" }], timestamp: new Date(2026, 0, 2, 0, 7).getTime() };
	pane.setLive(live);
	assert(!labels().includes("(2026-01-02 00:07)"));
	assert.equal(labels().filter((line) => /^Agent \d/.test(line)).length, 1, "the section retains its first timestamp");
	pane.setLive({ ...live, content: [{ type: "text", text: "completed" }] });
	assert(labels().includes("Agent 2026-01-01 14:32"), "stream updates keep the original section timestamp");
});

test("narrow panes wrap labels and timestamps without dropping the date or time", () => {
	const pane = new ConversationPane(session([
		entry("1", { ...assistant([{ type: "text", text: "answer" }]), timestamp: new Date(2026, 0, 2, 9, 5).getTime() }),
	]), theme);
	pane.setAgentRunning(true);
	for (const width of [17, 18, 24, 32]) {
		const lines = pane.render(width);
		assert(lines.every((line) => visibleWidth(line) === width));
		assert.equal(lines.map(stripTerminalSequences).map((line) => line.trim()).filter((line) => line && !/^─+$/.test(line)).join(" "),
			"Agent 2026-01-02 09:05 answer");
	}
});

test("missing or invalid timestamps leave plain role labels", () => {
	for (const timestamp of [undefined, null, "bad", NaN, Infinity, -Infinity, 8.64e15 + 1]) {
		const pane = new ConversationPane(session([
			entry("1", { ...user("hello"), timestamp }),
			entry("2", { ...assistant([{ type: "text", text: "answer" }]), timestamp }),
		]), theme);
		pane.setAgentRunning(true);
		const lines = pane.render(24).map(stripTerminalSequences).map((line) => line.trim());
		assert.deepEqual(lines, ["", "User", "─".repeat(20), "hello", "", "", "Agent", "─".repeat(20), "", "answer"]);
	}
});

const T0 = Date.UTC(2026, 0, 2, 9, 0, 0);
function timed(id, message, at, sentAt = at) {
	return { ...entry(id, { ...message, timestamp: sentAt }), timestamp: new Date(at).toISOString() };
}
function reply(text, stopReason = "stop") { return { ...assistant([{ type: "text", text }]), stopReason }; }
function toolUse() { return { ...assistant([{ type: "toolCall", id: "t", name: "read", arguments: {} }]), stopReason: "toolUse" }; }
function toolResult() { return { role: "toolResult", toolCallId: "t", toolName: "read", content: [], isError: false, timestamp: 0 }; }

test("activity summaries show gaps between visible agent messages, not cumulative section time", () => {
	const start = new Date(2026, 0, 2, 9, 0).getTime();
	const calls = Array.from({ length: 12 }, (_, index) => ({ type: "toolCall", id: `t${index}`, name: "read", arguments: {} }));
	const entries = [
		timed("1", user("question"), start),
		timed("2", assistant([{ type: "text", text: "first reply" }, ...calls]), start + 2_000, start),
		timed("3", assistant([{ type: "thinking", thinking: "one" }, { type: "thinking", thinking: "two" }, { type: "text", text: "second reply" }]), start + 508_000, start + 507_000),
		timed("4", assistant([{ type: "text", text: "third reply" }, { type: "toolCall", id: "next", name: "read", arguments: {} }]), start + 601_000, start + 600_000),
		timed("5", reply("fourth reply"), start + 1_108_000, start + 1_107_000),
	];
	assert.deepEqual(conversationItems(entries).filter((item) => item.role === "activity"), [
		{ role: "activity", toolCalls: 12, thinkingBlocks: 2, elapsedMs: 507_000 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0, elapsedMs: 507_000 },
	]);
	const pane = new ConversationPane(session(entries), theme);
	pane.setAgentRunning(true);
	const rows = pane.render(100);
	const plain = rows.map((line) => stripTerminalSequences(line).trim());
	assert(plain.includes("12 tool calls, 2 thinking blocks · 8m 27s"));
	assert(plain.includes("1 tool call, 0 thinking blocks · 8m 27s"), "even a text-only message resets the gap's starting point");
	assert(!plain.some((line) => /^\(\d{4}-/.test(line)));
	const summary = rows.find((line) => stripTerminalSequences(line).includes("12 tool calls"));
	assert(summary?.includes(theme.fg("success", theme.italic("12 tool calls"))));
	assert(summary?.includes(theme.fg("dim", theme.italic(", 2 thinking blocks · 8m 27s"))));
	entries.push(timed("6", user("follow-up"), start + 1_200_000),
		timed("7", assistant([{ type: "thinking", thinking: "new section" }]), start + 1_206_000, start + 1_205_000),
		timed("8", reply("new reply"), start + 1_266_000, start + 1_265_000));
	assert(pane.render(100).map(stripTerminalSequences).some((line) => line.trim() === "0 tool calls, 1 thinking block · 1m 00s"), "a new user interaction resets the interval");
});

test("activity durations omit missing, backwards, and sub-second timestamp differences", () => {
	const start = new Date(2026, 0, 2, 9, 0).getTime();
	for (const timestamp of [undefined, null, "bad", NaN, Infinity, start - 1_000, start + 500]) {
		const entries = [
			timed("1", assistant([{ type: "text", text: "first" }, { type: "toolCall", id: "t", name: "read", arguments: {} }]), start + 5_000, start),
			timed("2", reply("next"), start + 10_000, timestamp),
		];
		if (timestamp === undefined) entries[1].message.timestamp = undefined;
		const summary = conversationItems(entries).find((item) => item.role === "activity");
		assert.deepEqual(summary, { role: "activity", toolCalls: 1, thinkingBlocks: 0 }, "an unknown boundary must not reuse the previous completion timestamp");
	}
});

test("pending activity durations advance with tool results without changing section totals", () => {
	const start = new Date(2026, 0, 2, 9, 0).getTime();
	const entries = [timed("1", user("question"), start), timed("2", {
		...assistant([{ type: "text", text: "working" }, { type: "toolCall", id: "t", name: "read", arguments: {} }]), stopReason: "toolUse",
	}, start + 2_000, start)];
	const pane = new ConversationPane(session(entries), theme);
	pane.setAgentRunning(true);
	const lines = () => pane.render(100).map(stripTerminalSequences).map((line) => line.trim());
	assert(lines().includes("1 tool call, 0 thinking blocks · 2s"));
	entries.push(timed("3", toolResult(), start + 10_000));
	assert(lines().includes("1 tool call, 0 thinking blocks · 10s"));
	pane.setAgentRunning(false);
	assert(lines().includes("Total: 1 tool call, 0 thinking blocks · Agent turn 10s"));
	pane.invalidate();
	assert(lines().includes("1 tool call, 0 thinking blocks · 10s"));
});

test("thinking-first sections group activity durations, totals, and first-message metadata", () => {
	const start = new Date(2026, 0, 2, 9, 0).getTime();
	const thought = { ...assistant([{ type: "thinking", thinking: "one" }, { type: "thinking", thinking: "two" }]), model: "request-alias", responseModel: "served-first", stopReason: "toolUse" };
	const first = { ...assistant([
		{ type: "text", text: "first words" }, { type: "thinking", thinking: "three" },
		{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} },
	]), model: "later-model", stopReason: "toolUse" };
	const second = { ...assistant([
		{ type: "text", text: "second words" }, { type: "thinking", thinking: "four" },
		{ type: "toolCall", id: "c", name: "read", arguments: {} },
	]), stopReason: "toolUse" };
	const entries = [
		timed("1", user("question"), start),
		timed("2", thought, start + 7_000, start + 5_000),
		timed("3", first, start + 70_000, start + 60_000),
		timed("4", second, start + 130_000, start + 120_000),
		timed("5", reply("last words"), start + 185_000, start + 180_000),
		timed("6", user("follow-up"), start + 200_000),
		timed("7", { ...assistant([{ type: "thinking", thinking: "new turn" }]), model: "next-model" }, start + 207_000, start + 205_000),
	];
	const pane = new ConversationPane(session(entries), theme);
	pane.setAgentRunning(true);
	const rows = pane.render(120);
	const plain = rows.map((line) => stripTerminalSequences(line).trim());
	assert.deepEqual(plain.filter((line) => /^Agent \(/.test(line)), [
		"Agent (served-first) 2026-01-02 09:00", "Agent (next-model) 2026-01-02 09:03",
	]);
	assert(!plain.some((line) => line.includes("later-model")), "the section label belongs to the first agent message");
	assert(!plain.some((line) => /^\(2026-01-02 /.test(line)), "message timestamps are not rendered above the body");
	for (const [summary, text] of [
		["0 tool calls, 2 thinking blocks · 55s", "first words"],
		["2 tool calls, 1 thinking block · 1m 00s", "second words"],
		["1 tool call, 1 thinking block · 1m 00s", "last words"],
	]) {
		const index = plain.indexOf(summary);
		assert(index >= 0 && index < plain.indexOf(text), "each batch shows the gap before the next agent message");
		assert(rows[index].includes("\x1b[90m"), "activity durations stay subdued");
	}
	const footer = "Total: 3 tool calls, 4 thinking blocks · Agent turn 3m 05s · User turn 15s";
	const footerIndex = plain.indexOf(footer);
	assert(footerIndex > plain.indexOf("last words") && footerIndex < plain.indexOf("follow-up"));
	assert.equal(plain[footerIndex - 1], "─".repeat(116), "a closing rule separates totals from messages");
	assert(rows[footerIndex].includes(theme.fg("success", theme.italic("3 tool calls"))));
	assert(rows[footerIndex].includes(theme.fg("dim", theme.italic(", 4 thinking blocks"))));
	assert.equal(plain.filter((line) => line.startsWith("Total:")).length, 1, "the running section stays open");
	pane.setAgentRunning(false);
	assert(pane.render(120).map(stripTerminalSequences).some((line) => line.trim() === "Total: 0 tool calls, 1 thinking block · Agent turn 7s"), "each section resets its totals");
});

test("live updates keep one cached Agent header and count each activity block once in the footer", () => {
	const start = new Date(2026, 0, 2, 9, 0).getTime();
	const entries = [timed("1", user("question"), start), timed("2", {
		...assistant([{ type: "text", text: "persisted words" }, { type: "toolCall", id: "a", name: "read", arguments: {} }]),
		model: "first-model", stopReason: "toolUse",
	}, start + 5_000)];
	let headerRenders = 0;
	let branchReads = 0;
	const countingTheme = { ...theme, fg(color, text) {
		if (color === "warning" && text.includes("Agent")) headerRenders++;
		return theme.fg(color, text);
	} };
	const pane = new ConversationPane({ ...session(entries), getBranch() { branchReads++; return entries; } }, countingTheme);
	pane.setAgentRunning(true);
	pane.render(80);
	assert.equal(headerRenders, 1);
	const live = { ...assistant([]), model: "later-model", timestamp: start + 10_000 };
	for (const text of ["partial", "more words", "done"]) {
		live.content = [
			{ type: "thinking", thinking: "one" }, { type: "thinking", thinking: "two" }, { type: "text", text },
			{ type: "toolCall", id: "b", name: "read", arguments: {} }, { type: "toolCall", id: "c", name: "read", arguments: {} },
		];
		pane.setLive(live);
		const rows = pane.render(80).map(stripTerminalSequences).map((line) => line.trim());
		assert.equal(rows.filter((line) => /^Agent \(/.test(line)).length, 1);
		assert(rows.includes("1 tool call, 2 thinking blocks · 5s"));
		assert(rows.includes("2 tool calls, 0 thinking blocks"));
		assert(!rows.some((line) => line.startsWith("Total:")));
		assert.equal(headerRenders, 1, "live messages do not re-render the section header");
		assert.equal(branchReads, 1, "live messages do not re-read persisted history");
	}
	entries.push({ ...entry("3", live), timestamp: new Date(start + 20_000).toISOString() });
	pane.render(80);
	pane.setLive(undefined);
	pane.setAgentRunning(false);
	const rows = pane.render(120).map(stripTerminalSequences).map((line) => line.trim());
	assert.equal(rows.filter((line) => /^Agent \(/.test(line)).length, 1);
	assert.equal(rows.filter((line) => line === "done").length, 1);
	assert(rows.includes("Total: 3 tool calls, 2 thinking blocks · Agent turn 20s"));
	pane.invalidate();
	assert.deepEqual(pane.render(120).map(stripTerminalSequences).map((line) => line.trim()), rows);
});

test("elapsed times follow each agent turn and precede the user's reply", () => {
	const entries = [
		timed("1", user("question"), T0),
		timed("2", toolUse(), T0 + 5_000),
		timed("3", toolResult(), T0 + 8_000),
		timed("4", reply("answer"), T0 + 70_000),
		timed("5", user("thanks"), T0 + 100_000),
	];
	assert.deepEqual(conversationItems(entries), [
		{ role: "user", text: "question", timestamp: T0 },
		{ role: "agent-start", timestamp: T0 + 5_000 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 0, elapsedMs: 65_000 },
		{ role: "assistant", text: "answer", timestamp: T0 + 70_000 },
		{ role: "agent-end", toolCalls: 1, thinkingBlocks: 0, agentMs: 70_000, userMs: 30_000 },
		{ role: "user", text: "thanks", timestamp: T0 + 100_000 },
	]);
	const pane = new ConversationPane(session(entries), theme);
	const rows = pane.render(120).map((line) => stripTerminalSequences(line).trim()).filter((line) => line.includes("turn"));
	assert.deepEqual(rows, ["Total: 1 tool call, 0 thinking blocks · Agent turn 1m 10s · User turn 30s"], "totals and handoff timing share the section footer");
});

test("steering splits sections, and queued follow-ups have no user waiting time", () => {
	const entries = [
		timed("1", user("start"), T0),
		timed("2", toolUse(), T0 + 5_000),
		timed("3", user("also this"), T0 + 7_000, T0 + 6_000),
		timed("4", toolResult(), T0 + 8_000),
		timed("5", reply("done"), T0 + 20_000),
		// Typed while the agent worked, picked up once it finished.
		timed("6", user("next"), T0 + 21_000, T0 + 15_000),
		timed("7", reply("ok"), T0 + 31_000),
	];
	const footers = conversationItems(entries).filter((item) => item.role === "agent-end");
	assert.deepEqual(footers, [
		{ role: "agent-end", toolCalls: 1, thinkingBlocks: 0, agentMs: 7_000 },
		{ role: "agent-end", toolCalls: 0, thinkingBlocks: 0, agentMs: 13_000 },
	]);

	const pane = new ConversationPane(session(entries), theme);
	const times = () => pane.render(120).map((line) => stripTerminalSequences(line).trim()).filter((line) => line.includes("turn")).map((line) => line.split(" · ").at(-1));
	assert.deepEqual(times(), ["Agent turn 7s", "Agent turn 13s", "Agent turn 10s"], "each user interaction bounds a section's timing");
	pane.setAgentRunning(true);
	assert.deepEqual(times(), ["Agent turn 7s", "Agent turn 13s"], "a running section has no footer yet");
});

test("elapsed times are appended incrementally and skip sub-second spans", () => {
	const entries = [timed("1", user("hi"), T0), timed("2", reply("hello"), T0 + 500)];
	const pane = new ConversationPane(session(entries), theme);
	const times = () => pane.render(120).map((line) => stripTerminalSequences(line).trim()).filter((line) => line.includes("turn")).map((line) => line.split(" · ").at(-1));
	assert.deepEqual(times(), []);
	entries.push(timed("3", user("more"), T0 + 125_000), timed("4", reply("sure"), T0 + 3_725_000));
	assert.deepEqual(times(), ["User turn 2m 04s", "Agent turn 1h 00m"], "a missing agent duration leaves the user waiting time alone");
});

test("elapsed durations are compact at every scale", () => {
	assert.equal(formatElapsed(1_999), "1s");
	assert.equal(formatElapsed(59_000), "59s");
	assert.equal(formatElapsed(61_000), "1m 01s");
	assert.equal(formatElapsed(3_600_000), "1h 00m");
	assert.equal(formatElapsed(90_000_000), "1d 01h");
});

const askArgs = { questions: [
	{ question: "How should `install.sh` work?", header: "Installer", options: [{ label: "Node script", description: "hidden" }, { label: "POSIX sh", description: "hidden", preview: "hidden" }] },
	{ question: "Which extras?", header: "Extras", multiSelect: true, options: [{ label: "Settings", description: "" }, { label: "Themes", description: "" }] },
	{ question: "Anything else?", options: [{ label: "No", description: "" }, { label: "Yes", description: "" }] },
] };
function ask(args = askArgs, text = "Before I start:") {
	return { ...assistant([{ type: "thinking", thinking: "" }, ...(text ? [{ type: "text", text }] : []), { type: "toolCall", id: "q", name: "ask_user_question", arguments: args }]), stopReason: "toolUse" };
}
function answered(details, extra = {}) {
	return { role: "toolResult", toolCallId: "q", toolName: "ask_user_question", content: [{ type: "text", text: "hidden" }], details, isError: false, ...extra };
}
const answerDetails = { cancelled: false, globalNote: "keep it short", answers: [
	{ questionIndex: 0, question: "How should `install.sh` work?", kind: "custom", answer: "Node, typed", notes: "small" },
	{ questionIndex: 1, question: "Which extras?", kind: "multi", answer: null, selected: ["Settings", "Themes"] },
] };

test("ask_user_question shows the questions to the agent's section and the answers as a User section", () => {
	const entries = [
		timed("1", user("start"), T0),
		timed("2", toolUse(), T0 + 5_000),
		timed("3", toolResult(), T0 + 6_000),
		timed("4", ask(), T0 + 20_000),
		timed("5", answered(answerDetails), T0 + 92_000),
		timed("6", reply("done"), T0 + 150_000),
	];
	assert.deepEqual(conversationItems(entries), [
		{ role: "user", text: "start", timestamp: T0 },
		{ role: "agent-start", timestamp: T0 + 5_000 },
		{ role: "activity", toolCalls: 1, thinkingBlocks: 1, elapsedMs: 15_000 },
		{ role: "assistant", text: "Before I start:", timestamp: T0 + 20_000 },
		{ role: "questions", questions: [
			{ header: "Installer", question: "How should `install.sh` work?", options: ["Node script", "POSIX sh"], multiSelect: false },
			{ header: "Extras", question: "Which extras?", options: ["Settings", "Themes"], multiSelect: true },
			{ question: "Anything else?", options: ["No", "Yes"], multiSelect: false },
		] },
		{ role: "agent-end", toolCalls: 2, thinkingBlocks: 1, agentMs: 20_000, userMs: 72_000 },
		{ role: "answers", declined: false, note: "keep it short", timestamp: T0 + 92_000, answers: [
			{ label: "Installer", answer: "Node, typed", notes: "small" },
			{ label: "Extras", answer: "Settings, Themes" },
			{ label: "Anything else?" },
		] },
		{ role: "agent-start", timestamp: T0 + 150_000 },
		{ role: "assistant", text: "done", timestamp: T0 + 150_000 },
	]);

	const pane = new ConversationPane(session(entries), theme);
	assert.deepEqual(pane.getStats(), { userMessages: 1, agentMessages: 2, toolCalls: 2, thinkingBlocks: 1 }, "the questionnaire stays a tool call");
	const rows = pane.render(80).map((line) => stripTerminalSequences(line).trim());
	const from = (text) => rows.indexOf(text);
	assert.deepEqual(rows.slice(from("? Installer"), from("Total: 2 tool calls, 1 thinking block · Agent turn 20s · User turn 1m 12s") + 1), [
		"? Installer", "How should install.sh work?", "• Node script", "• POSIX sh", "",
		"? Extras (select any)", "Which extras?", "• Settings", "• Themes", "",
		"? Question", "Anything else?", "• No", "• Yes",
		"─".repeat(76), "Total: 2 tool calls, 1 thinking block · Agent turn 20s · User turn 1m 12s",
	]);
	assert.deepEqual(rows.slice(from(`User · answered ${messageDate(T0 + 92_000)}`)), [
		`User · answered ${messageDate(T0 + 92_000)}`, "─".repeat(76),
		"Installer → Node, typed", "note: small", "Extras → Settings, Themes", "Anything else? → (no answer)", "Note: keep it short",
		"", "", `Agent ${messageDate(T0 + 150_000)}`, "─".repeat(76), "", "done", "─".repeat(76), "Total: 0 tool calls, 0 thinking blocks · Agent turn 58s",
	]);
	assert(!rows.join("\n").includes("hidden"), "option descriptions, previews, and the tool's text result stay hidden");
	const styled = pane.render(80).join("\n");
	assert(styled.includes(theme.fg("accent", theme.bold("? Installer"))));
	assert(styled.includes(theme.fg("syntaxType", theme.bold("Installer"))));
	for (const width of [12, 24, 40]) assert(pane.render(width).every((line) => visibleWidth(line) === width));
});

function messageDate(at) {
	const date = new Date(at);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test("declined questionnaires end the section, and unseen ones stay in it", () => {
	const declined = [timed("1", user("start"), T0), timed("2", ask(), T0 + 5_000), timed("3", answered({ answers: [], cancelled: true }), T0 + 30_000)];
	const rows = new ConversationPane(session(declined), theme).render(80).map((line) => stripTerminalSequences(line).trim());
	assert.deepEqual(rows.slice(-2), ["─".repeat(76), "Declined to answer"]);
	assert(rows.includes("Total: 1 tool call, 1 thinking block · Agent turn 5s · User turn 25s"));

	for (const result of [answered({ answers: [], cancelled: true, error: "no_ui" }), answered(undefined, { isError: true })]) {
		const unseen = [timed("1", user("start"), T0), timed("2", ask(), T0 + 5_000), timed("3", result, T0 + 6_000), timed("4", reply("asking in chat"), T0 + 9_000)];
		const items = conversationItems(unseen);
		assert.deepEqual(items.slice(4).map((item) => item.role), ["questions", "notice", "assistant"], "the section stays open");
		assert(new ConversationPane(session(unseen), theme).render(80).some((line) => stripTerminalSequences(line).includes("The questions were not shown to the user.")));
	}
});

test("streamed questions render from partial arguments and answers append incrementally", () => {
	const entries = [timed("1", user("start"), T0)];
	const pane = new ConversationPane(session(entries), theme);
	pane.setAgentRunning(true);
	const live = ask({ questions: [{ question: "Which", options: [{ label: "A" }, {}] }, { header: "Partial" }] }, "");
	pane.setLive(live);
	let rows = pane.render(40).map((line) => stripTerminalSequences(line).trim());
	assert.deepEqual(rows.slice(-3), ["? Question", "Which", "• A"]);
	assert(rows.includes("0 tool calls, 1 thinking block"), "the questionnaire is not summarized as hidden activity");
	assert.equal(pane.getStats().toolCalls, 1);

	const question = ask();
	pane.setLive(question);
	entries.push(timed("2", question, T0 + 5_000));
	pane.setLive(undefined);
	pane.render(40);
	entries.push(timed("3", answered(answerDetails), T0 + 30_000), timed("4", reply("done"), T0 + 40_000));
	pane.setAgentRunning(false);
	rows = pane.render(40);
	const rebuilt = new ConversationPane(session(entries), theme).render(40);
	assert.deepEqual(rows, rebuilt, "appending the answer matches a full rebuild");
	assert(rows.map(stripTerminalSequences).some((line) => line.includes("Installer → Node, typed")));
});

test("pane wraps long words, lines and wide graphemes within its width", () => {
	const entries = [entry("1", user("one long examplewithnobreaksinthemiddlebutplentyofletters 中文🙂\nnew line")),
		entry("2", assistant([{ type: "text", text: "reply" }]))];
	const pane = new ConversationPane(session(entries), theme);
	const lines = pane.render(18);
	assert(lines.length > 9);
	assert(lines.every((line) => visibleWidth(line) === 18));
	assert(lines.some((line) => line.includes("\x1b[34m") && line.includes("User")));
	assert(lines.some((line) => line.includes("\x1b[33m") && line.includes("Agent")));
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
	const layout = new TranscriptDigestLayout(tui, theme, pane);
	assert.equal(layout.enable(), "enabled");
	assert.equal(layout.isEnabled, true);
	assert.equal(layout.isEditorFocused, true);
	assert.equal(layout.enable(), "enabled", "enable is idempotent");
	const split = tui.layoutRoot.children[0];
	assert(split instanceof HStack);
	assert.equal(split.children.length, 2);
	assert.equal(split.children[0].children[0], transcript, "left pane is Pi's original transcript");
	assert.equal(tui.layoutRoot.children[1], dock, "the input dock is unchanged");
	const right = split.children[1];
	assert(right instanceof VStack);
	const header = right.children[0];
	const headerRows = (width) => header.render(width + 1).map(stripTerminalSequences).map((line) => {
		assert.equal(line[0], "│", "the header row starts with the divider");
		return line.slice(1);
	});
	assert.deepEqual(headerRows(91), [
		" Transcript Digest   1 User Messages · 0 Agent Messages · 0 Tool Calls · 0 Thinking Blocks ",
	], "counts share the title row, right-aligned");
	assert.deepEqual(headerRows(60).map((line) => line.trimEnd()), [
		" Transcript Digest       1 User Messages · 0 Agent Messages",
		"                           0 Tool Calls · 0 Thinking Blocks",
	], "counts that do not fit beside the title wrap right-aligned");
	assert(headerRows(60).every((line) => visibleWidth(line) === 60));
	assert.deepEqual(headerRows(20).map((line) => line.trim()), [
		"Transcript Digest", "1 User Messages", "0 Agent Messages", "0 Tool Calls", "0 Thinking Blocks",
	], "a narrow pane gives the title its own row");
	const side = right.children[1];
	assert(side instanceof ScrollView);
	assert.equal(side.scrollbar, "hidden", "the pane paints its own scrollbar");
	assert.equal(right.children.length, 3, "only the scrollbar continuation follows the conversation");
	assert.deepEqual(stripTerminalSequences(right.children[2].render(5)[0]), "│   ┃");

	side.updateLayout(60, 10, () => {});
	layout.scroll("up");
	assert.equal(side.scrollTop, 42);
	assert.equal(right.handleMouse({ type: "wheel", wheelDelta: -3 }).handled, true);
	assert.equal(side.scrollTop, 39);
	const click = { type: "click", button: "left", x: 2, y: 5, screenX: 43, screenY: 5, width: 40, height: 23 };
	assert.equal(right.handleMouse(click), undefined, "unhandled clicks remain available to Pi's selection");
	layout.scroll("end");
	assert.equal(side.scrollTop, 50);
	layout.disable();
	assert.equal(tui.layoutRoot, originalRoot);
	assert.equal(layout.isEnabled, false);
});

function fullscreenSplit(messages, { columns = 81, rows = 24 } = {}) {
	const terminal = {
		columns, rows, kittyProtocolActive: false,
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
	const layout = new TranscriptDigestLayout(tui, theme, new ConversationPane(session(messages), theme));
	assert.equal(layout.enable(), "enabled");
	tui.start();
	tui.renderNow();
	const side = tui.layoutRoot.children[0].children[1].children[1];
	const screen = () => tui.getScreenLines().map(stripTerminalSequences);
	const headerHeight = () => screen().length - 1 - side.viewportHeight; // the dock is one row
	const close = () => {
		layout.disable();
		tui.stop({ preserveScreen: true });
	};
	return { terminal, tui, layout, transcript, side, screen, headerHeight, close };
}

const manyMessages = () => Array.from({ length: 40 }, (_, index) => entry(String(index + 1), user(`Message ${index + 1}`)));

test("the right pane paints its divider and scrollbar into the frame", () => {
	const { terminal, tui, layout, side, screen, headerHeight, close } = fullscreenSplit(manyMessages());
	try {
		const conversationRows = screen().slice(headerHeight(), headerHeight() + side.viewportHeight);
		assert(screen().slice(0, -1).every((line) => line[40] === "│"), "the panes share the available columns equally");
		assert(screen().slice(0, -1).every((line) => visibleWidth(line) === 81));
		assert(screen()[0].includes("Transcript Digest"));
		const bar = conversationRows.map((line) => line[80]).join("");
		assert.match(bar, /^│+┃+$/, "following the latest message puts the thumb at the end of the track");
		assert(conversationRows.some((line) => line.slice(41, 80).includes("Message 40")));

		terminal.columns = 40;
		layout.reconcile();
		tui.renderNow();
		assert(screen().slice(0, -1).every((line) => line[19] === "│"), "resize keeps a 50/50 split");
		assert(screen()[0].includes("Transcript Digest"));

		terminal.columns = MIN_SPLIT_COLUMNS - 1;
		layout.reconcile();
		tui.renderNow();
		assert(!screen().some((line) => line.includes("Transcript Digest") || line.includes("│")), "a narrow terminal hides the right pane");
		assert(screen().every((line) => visibleWidth(line) <= MIN_SPLIT_COLUMNS - 1));
	} finally {
		close();
	}
});

test("a conversation shorter than the pane keeps the divider and a full-height thumb", () => {
	const { side, screen, headerHeight, close } = fullscreenSplit([entry("1", user("hello"))]);
	try {
		assert(headerHeight() > 3, "the conversation is shorter than the pane");
		const header = screen().findLastIndex((line) => line.includes("Thinking Blocks"));
		const paneRows = screen().slice(header + 1, -1);
		assert(paneRows.every((line) => line[40] === "│" && line[80] === "┃"));
	} finally {
		close();
	}
});

test("selecting right pane text copies no divider or scrollbar glyphs", () => {
	const { tui, side, headerHeight, close } = fullscreenSplit(manyMessages());
	try {
		const top = headerHeight() + side.viewportHeight - 3; // the last four conversation rows, 1-based
		tui.handleTerminalInput(`\x1b[<0;42;${top}M`);
		tui.handleTerminalInput(`\x1b[<32;81;${top + 3}M`);
		tui.handleTerminalInput(`\x1b[<0;81;${top + 3}m`);
		const text = tui.getActiveSelectionText();
		assert(text?.includes("Message 40"), "the selection covers conversation text");
		assert(!/[│┃█]/.test(text), "the selection excludes painted glyphs");
	} finally {
		close();
	}
});

test("fullscreen mouse press and drag scroll the right scrollbar independently", () => {
	const { terminal, tui, transcript, side, screen, headerHeight, close } = fullscreenSplit(manyMessages());
	try {
		const atEnd = side.scrollTop;
		assert(atEnd > 0, "conversation exceeds its viewport");
		const x = terminal.columns;
		const thumbY = headerHeight() + side.viewportHeight; // 1-based row of the last scrollbar cell
		const thumbAt = () => {
			tui.renderNow();
			return screen()[thumbY - 1][x - 1];
		};
		tui.handleTerminalInput(`\x1b[<35;${x};${thumbY}M`); // hover the thumb
		assert.equal(thumbAt(), "█", "hovering the bar highlights the thumb");
		tui.handleTerminalInput(`\x1b[<35;${x - 20};${thumbY}M`);
		assert.equal(thumbAt(), "┃", "leaving the bar for the pane clears the highlight");
		tui.handleTerminalInput(`\x1b[<35;${x};${thumbY}M`);
		tui.handleTerminalInput(`\x1b[<35;${x};${terminal.rows}M`); // the dock row below the pane
		assert.equal(thumbAt(), "┃", "leaving the bar for the dock clears the highlight");
		tui.handleTerminalInput(`\x1b[<0;${x};${thumbY}M`); // press the scrollbar thumb
		assert.equal(thumbAt(), "█", "a held thumb is highlighted");
		tui.handleTerminalInput(`\x1b[<32;${x};4M`); // drag while holding the primary button
		assert(side.scrollTop < atEnd, "drag moves the right pane up");
		const afterDragUp = side.scrollTop;
		tui.handleTerminalInput(`\x1b[<32;${x};${thumbY}M`);
		assert(side.scrollTop > afterDragUp, "drag moves the right pane down");
		tui.handleTerminalInput(`\x1b[<0;${x - 20};${thumbY}m`); // release off the bar
		assert.equal(thumbAt(), "┃", "release off the bar restores the thumb");
		assert.equal(transcript.scrollTop, 0, "the left transcript is not scrolled");
		assert.equal(tui.hasActiveSelection(), false, "dragging the scrollbar selects no text");

		const trackTop = headerHeight() + 1;
		tui.handleTerminalInput(`\x1b[<0;${x};${trackTop}M`); // press the track above the thumb
		tui.handleTerminalInput(`\x1b[<0;${x};${trackTop}m`);
		assert.equal(side.scrollTop, 0, "pressing the track's top jumps to the start");
	} finally {
		close();
	}
});

test("incompatible or regular layouts remain untouched", () => {
	const renderer = {
		mode: "regular", layoutRoot: undefined, children: [], terminal: { columns: 80, rows: 20 },
		setLayoutRoot(root) { this.layoutRoot = root; }, requestRender() {},
	};
	const layout = new TranscriptDigestLayout(renderer, theme, new ConversationPane(session(), theme));
	assert.equal(layout.enable(), "fullscreen-required");
	renderer.mode = "fullscreen";
	renderer.layoutRoot = new Container();
	assert.equal(layout.enable(), "unsupported-layout");
	assert(renderer.layoutRoot instanceof Container);
});
