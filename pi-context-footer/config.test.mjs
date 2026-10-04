import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_CONFIG, parseHostnameSettings, parseLayout, readFooterConfig } from "./config.ts";

const examples = new URL("./examples/", import.meta.url);
const example = (name) => JSON.parse(readFileSync(new URL(name, examples), "utf8"));
const ids = (items) => items.map((item) => (item.kind === "builtin" ? item.id : `status:${item.key}`));

test("the shipped default layout is the documented example", () => {
	assert.deepEqual(example("default-layout.json").layout, DEFAULT_LAYOUT_CONFIG);
	assert.deepEqual(parseLayout(example("default-layout.json").layout).layout, DEFAULT_LAYOUT);
});

test("an omitted region inherits its default; a given one replaces it", () => {
	const { layout } = parseLayout({ topLeft: ["context", "model"] });
	assert.deepEqual(ids(layout.topLeft), ["context", "model"]);
	assert.deepEqual(ids(layout.topRight), ["session-name"]);
	assert.deepEqual(ids(layout.bottomRight), ["branch", "pull-request", "tokens", "status:background-tasks", "status:write-lock"]);
});

test("[] empties a region", () => {
	const { layout, problems } = parseLayout({ bottomLeft: [], bottomRight: [] });
	assert.deepEqual(problems, []);
	assert.deepEqual(layout.bottomLeft, []);
	assert.deepEqual(layout.bottomRight, []);
});

test("status items take a key and an optional color", () => {
	const { layout } = parseLayout({ topRight: [{ status: "example-cost" }, { status: "other", color: "warning" }] });
	assert.deepEqual(layout.topRight, [
		{ kind: "status", key: "example-cost", color: "accent" },
		{ kind: "status", key: "other", color: "warning" },
	]);
});

test("a built-in name and a status key with the same spelling do not collide", () => {
	const { problems } = parseLayout({ topLeft: ["tokens"], topRight: [{ status: "tokens" }], bottomRight: [] });
	assert.deepEqual(problems, []);
});

test("any problem rejects the whole layout", () => {
	const rejected = (value, pattern) => {
		const { layout, problems } = parseLayout(value);
		assert.equal(layout, null, JSON.stringify(value));
		assert.match(problems.join("\n"), pattern);
	};
	rejected([], /must be an object/);
	rejected({ middle: [] }, /"layout.middle" is not a region/);
	rejected({ topLeft: "model" }, /must be an array/);
	rejected({ topLeft: ["cost"] }, /unknown built-in item "cost"/);
	rejected({ topLeft: [42] }, /built-in item name or/);
	rejected({ topLeft: [{ colour: "accent" }] }, /needs "status"/);
	rejected({ topLeft: [{ status: "" }] }, /non-empty string/);
	rejected({ topLeft: [{ status: "x", colour: "red" }] }, /unknown option "colour"/);
	rejected({ topLeft: ["model"], topRight: ["model"] }, /built-in item "model" is already selected/);
	rejected({ topLeft: [{ status: "x" }], bottomLeft: [{ status: "x" }] }, /status "x" is already selected/);
	// The default bottom-right already selects "tokens".
	rejected({ topLeft: ["tokens"] }, /"tokens" is already selected/);
});

test("colors are checked against the theme", () => {
	const isColor = (name) => name === "accent" || name === "warning";
	assert.equal(parseLayout({ topLeft: [{ status: "x", color: "warning" }] }, isColor).problems.length, 0);
	assert.match(parseLayout({ topLeft: [{ status: "x", color: "chartreuse" }] }, isColor).problems[0], /theme color/);
});

test("hostname settings keep their valid entries", () => {
	const { settings, problems } = parseHostnameSettings({ show: true, nickname: "x", nicknames: { a: "", b: "bee" } });
	assert.equal(settings.show, true);
	assert.equal(settings.nicknames.get("b"), "bee");
	assert.equal(problems.length, 2);
});

test("readFooterConfig: missing, malformed and partial files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-footer-config-test-"));
	try {
		const file = join(dir, "config.json");
		assert.deepEqual(readFooterConfig(file).problems, []);
		assert.equal(readFooterConfig(file).layout, DEFAULT_LAYOUT);

		writeFileSync(file, "{ not json");
		assert.deepEqual(readFooterConfig(file), { layout: null, hostname: null, problems: ["config.json is not valid JSON"] });

		writeFileSync(file, JSON.stringify({ animate: false, layout: { topLeft: ["nope"] }, hostname: { show: true } }));
		const load = readFooterConfig(file);
		assert.equal(load.layout, null);
		assert.equal(load.hostname.show, true);
		assert.equal(load.problems.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
