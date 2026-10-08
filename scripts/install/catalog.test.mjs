import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverExtensions } from "./catalog.mjs";
import { agentDirectory, displayPath } from "./paths.mjs";

const checkout = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function repo(t, packages) {
	const root = mkdtempSync(join(tmpdir(), "pi-install-catalog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, manifest] of Object.entries(packages)) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
	}
	return root;
}

test("an extension is a directory whose package.json declares pi.extensions", (t) => {
	const root = repo(t, {
		"pi-b": { description: "Pi extension: does b.", pi: { extensions: ["./index.ts"] } },
		"pi-a": { description: "Does a.", pi: { extensions: ["./index.ts"] } },
		lib: { name: "not-an-extension" },
		"pi-broken": "{",
	});
	const { extensions, problems } = discoverExtensions(root);
	assert.deepEqual(extensions, [
		{ name: "pi-a", description: "Does a.", settings: [] },
		{ name: "pi-b", description: "Does b.", settings: [] },
	]);
	assert.deepEqual(problems, ["pi-broken/package.json is not valid JSON"]);
});

test("an unusable settings entry drops that extension's settings, with the reason", (t) => {
	const valid = { key: "style", prompt: "Style", type: "choice", choices: ["frame", "clean"], default: "frame" };
	const root = repo(t, {
		"pi-a": { pi: { extensions: [] }, settings: [valid, { ...valid, default: "box" }] },
		"pi-b": { pi: { extensions: [] }, settings: [valid, valid] },
		"pi-c": { pi: { extensions: [] }, settings: [valid] },
	});
	const { extensions, problems } = discoverExtensions(root);
	assert.deepEqual(extensions.map(({ settings }) => settings.length), [0, 0, 1]);
	assert.deepEqual(problems, [
		"pi-a: settings[1] style: \"default\" is not a value the setting accepts",
		"pi-b: settings[1] style: declared twice",
	]);
});

test("every extension in this checkout has usable settings", () => {
	const { extensions, problems } = discoverExtensions(checkout);
	assert.deepEqual(problems, []);
	assert.ok(extensions.some(({ settings }) => settings.length > 0));
});

test("the agent directory follows PI_CODING_AGENT_DIR as pi expands it", () => {
	const home = "/home/someone";
	assert.equal(agentDirectory({}, home), "/home/someone/.pi/agent");
	assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "~/agent" }, home), "/home/someone/agent");
	assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "~" }, home), home);
	assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "/srv/pi" }, home), "/srv/pi");
	assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "rel" }, home), resolve("rel"));
	assert.equal(displayPath(join(homedir(), ".pi", "agent")), "~/.pi/agent");
	assert.equal(displayPath("/srv/pi"), "/srv/pi");
});
