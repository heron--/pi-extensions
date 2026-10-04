import assert from "node:assert/strict";
import test from "node:test";
import writeLockExtension, { writeLockStatusText } from "./index.ts";

const LOCKED = String.fromCodePoint(0xf033e);
const UNLOCKED = String.fromCodePoint(0xf033f);

test("the status text carries an icon derived from the state", () => {
	assert.equal(writeLockStatusText(true), `${LOCKED} write locked`);
	assert.equal(writeLockStatusText(false), `${UNLOCKED} write unlocked`);
});

/** A fake pi and session: just what the extension reads and writes. */
function host(branchEntries = []) {
	const handlers = new Map();
	const commands = new Map();
	const state = { statuses: new Map(), activeTools: ["read", "edit", "write", "bash"], appended: [], branch: branchEntries };
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getActiveTools: () => state.activeTools,
		setActiveTools: (tools) => (state.activeTools = tools),
		appendEntry: (customType, data) => state.appended.push({ type: "custom", customType, data }),
	};
	const ctx = {
		ui: {
			theme: { fg: (color, text) => `<${color}>${text}` },
			setStatus: (key, text) => state.statuses.set(key, text),
			notify: () => {},
		},
		sessionManager: { getBranch: () => state.branch },
	};
	writeLockExtension(pi);
	return {
		state,
		emit: (event, payload = {}) => handlers.get(event)?.(payload, ctx),
		command: (args) => commands.get("write-lock").handler(args, ctx),
		status: () => state.statuses.get("write-lock"),
	};
}

const lockEntry = (locked) => ({ type: "custom", customType: "write-lock-state", data: { locked } });

test("both states are published, styled for pi's own footer", async () => {
	const session = host();
	await session.emit("session_start");
	assert.equal(session.status(), `<dim>${UNLOCKED} write unlocked`);
	await session.command("on");
	assert.equal(session.status(), `<warning>${LOCKED} write locked`);
	await session.command("off");
	assert.equal(session.status(), `<dim>${UNLOCKED} write unlocked`);
});

test("session start and tree navigation publish the restored branch's state", async () => {
	const session = host([lockEntry(true)]);
	await session.emit("session_start");
	assert.equal(session.status(), `<warning>${LOCKED} write locked`);
	assert.deepEqual(session.state.activeTools, ["read", "bash"]);

	session.state.branch = [lockEntry(true), lockEntry(false)];
	await session.emit("session_tree");
	assert.equal(session.status(), `<dim>${UNLOCKED} write unlocked`);
	assert.deepEqual(session.state.activeTools.sort(), ["bash", "edit", "read", "write"]);
});

test("enforcement is unchanged by the presentation", async () => {
	const session = host();
	await session.emit("session_start");
	await session.command("on");
	assert.equal((await session.emit("tool_call", { toolName: "write", input: {} }))?.block, true);
	assert.equal((await session.emit("tool_call", { toolName: "bash", input: { command: "echo hi > f" } }))?.block, true);
	assert.equal(await session.emit("tool_call", { toolName: "bash", input: { command: "ls" } }), undefined);
	await session.command("off");
	assert.equal(await session.emit("tool_call", { toolName: "write", input: {} }), undefined);
});
