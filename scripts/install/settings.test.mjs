import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	currentValue,
	describeAllowed,
	formatValue,
	getPath,
	parseAnswer,
	readConfig,
	setPath,
	settingProblem,
	writeConfig,
} from "./settings.mjs";

const toggle = { key: "hostname.show", prompt: "Show it", type: "boolean", default: false };
const style = { key: "style", prompt: "Style", type: "choice", choices: ["frame", "clean"], default: "frame" };
const minutes = { key: "intervalMinutes", prompt: "Minutes", type: "number", min: 0.05, max: 240, default: 5 };
const rounds = { key: "rounds", prompt: "Rounds", type: "integer", min: 1, max: 1000, default: 5 };
const label = { key: "label", prompt: "Label", type: "string", default: "recap" };

function scratch(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-install-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("settingProblem accepts each type and names what is wrong otherwise", () => {
	for (const setting of [toggle, style, minutes, rounds, label]) assert.equal(settingProblem(setting), undefined);
	const problems = [
		[null, /object/],
		[{ ...toggle, key: "a..b" }, /dotted path/],
		[{ ...toggle, prompt: " " }, /prompt/],
		[{ ...toggle, type: "list" }, /type/],
		[{ ...style, choices: ["frame"] }, /two strings/],
		[{ ...style, choices: ["frame", "Frame"] }, /case/],
		[{ ...minutes, min: "1" }, /"min" must be a number/],
		[{ ...minutes, min: 10, max: 1 }, /exceeds/],
		[{ ...rounds, default: 2.5 }, /default/],
		[{ ...minutes, default: 300 }, /default/],
		[{ ...style, default: "box" }, /default/],
		[{ ...label, default: "" }, /default/],
	];
	for (const [entry, pattern] of problems) assert.match(settingProblem(entry), pattern, JSON.stringify(entry));
});

test("parseAnswer keeps the current value on Enter and validates what is typed", () => {
	assert.deepEqual(parseAnswer(toggle, "  "), { keep: true });
	assert.deepEqual(parseAnswer(toggle, "Yes"), { value: true });
	assert.deepEqual(parseAnswer(toggle, "off"), { value: false });
	assert.ok(parseAnswer(toggle, "maybe").error);
	assert.deepEqual(parseAnswer(style, "CLEAN"), { value: "clean" });
	assert.match(parseAnswer(style, "box").error, /frame, clean/);
	assert.deepEqual(parseAnswer(minutes, "0.5"), { value: 0.5 });
	assert.match(parseAnswer(minutes, "0.01").error, /0\.05–240/);
	assert.ok(parseAnswer(minutes, "soon").error);
	assert.deepEqual(parseAnswer(rounds, "12"), { value: 12 });
	assert.ok(parseAnswer(rounds, "2.5").error);
	assert.deepEqual(parseAnswer(label, " my recap "), { value: "my recap" });
});

test("describeAllowed and formatValue read as the prompt shows them", () => {
	assert.equal(describeAllowed(toggle), "yes, no");
	assert.equal(describeAllowed(style), "frame, clean");
	assert.equal(describeAllowed(minutes), "0.05–240");
	assert.equal(describeAllowed({ ...rounds, max: undefined }), "whole number ≥ 1");
	assert.equal(describeAllowed(label), "text");
	assert.equal(formatValue(toggle, true), "yes");
	assert.equal(formatValue(minutes, 5), "5");
});

test("dotted keys read and write nested objects", () => {
	const config = { hostname: { match: "^box" } };
	assert.equal(getPath(config, "hostname.match"), "^box");
	assert.equal(getPath(config, "hostname.show"), undefined);
	assert.equal(getPath({ hostname: "x" }, "hostname.show"), undefined);
	setPath(config, "hostname.show", true);
	setPath(config, "a.b.c", 1);
	assert.deepEqual(config, { hostname: { match: "^box", show: true }, a: { b: { c: 1 } } });
	assert.throws(() => setPath({ hostname: "x" }, "hostname.show", true), /"hostname" is not an object/);
});

test("currentValue prefers a valid stored value over the default", () => {
	assert.equal(currentValue(minutes, { intervalMinutes: 12 }), 12);
	assert.equal(currentValue(minutes, { intervalMinutes: "12" }), 5);
	assert.equal(currentValue(toggle, {}), false);
	assert.equal(currentValue(toggle, { hostname: { show: true } }), true);
});

test("readConfig treats a missing file as empty and refuses one that does not parse", (t) => {
	const root = scratch(t);
	assert.deepEqual(readConfig(join(root, "none.json")), { config: {} });
	writeFileSync(join(root, "broken.json"), "{ \"style\": ");
	assert.match(readConfig(join(root, "broken.json")).error, /not valid JSON/);
	writeFileSync(join(root, "list.json"), "[]");
	assert.match(readConfig(join(root, "list.json")).error, /object/);
});

test("writeConfig merges into the file as it is, creating it when needed", (t) => {
	const root = scratch(t);
	const path = join(root, "pi-recap", "config.json");
	assert.deepEqual(writeConfig(path, [["style", "clean"]]), {});
	writeFileSync(path, JSON.stringify({ style: "clean", markers: { recap: "R" }, unknown: [1] }));
	assert.deepEqual(writeConfig(path, [["intervalMinutes", 10], ["markers.next", "N"]]), {});
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		style: "clean",
		markers: { recap: "R", next: "N" },
		unknown: [1],
		intervalMinutes: 10,
	});
});

test("writeConfig updates a symlinked file at its target and leaves a broken file alone", (t) => {
	const root = scratch(t);
	const shared = join(root, "dotfiles", "config.json");
	const link = join(root, "agent", "pi-recap", "config.json");
	mkdirSync(join(root, "dotfiles"));
	mkdirSync(join(root, "agent", "pi-recap"), { recursive: true });
	writeFileSync(shared, "{}\n");
	symlinkSync(shared, link);
	assert.deepEqual(writeConfig(link, [["style", "clean"]]), {});
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")), { style: "clean" });

	writeFileSync(shared, "{ hand edit");
	assert.match(writeConfig(link, [["style", "frame"]]).error, /not valid JSON/);
	assert.equal(readFileSync(shared, "utf8"), "{ hand edit");
	writeFileSync(shared, JSON.stringify({ hostname: "laptop" }));
	assert.match(writeConfig(link, [["hostname.show", true]]).error, /"hostname" is not an object/);
	assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")), { hostname: "laptop" });
});
