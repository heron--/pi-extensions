import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BASH_OUTPUT_MODES,
	DEFAULT_TOOL_OUTPUT_CONFIG,
	OUTPUT_MODES,
	loadToolOutputConfig,
	normalizeKeyId,
	normalizeToolOutputConfig,
	saveToolOutputConfig,
} from "./config.ts";

test("expandLastKey accepts any pi key ID and rejects anything else", () => {
	for (const [input, expected] of [
		["alt+o", "alt+o"], ["alt+/", "alt+/"], ["ctrl+;", "ctrl+;"], ["alt+=", "alt+="], ["ctrl+\\", "ctrl+\\"],
		["alt++", "alt++"], ["+", "+"], ["f5", "f5"], ["ALT+O", "alt+o"], ["ctrl+shift+PageUp", "ctrl+shift+pageUp"],
	]) assert.equal(normalizeKeyId(input), expected, input);
	for (const input of ["", "alt+", "hyper+o", "alt+alt+o", "alt+oo", "alt+ ", "ctrl+f13"]) {
		assert.equal(normalizeKeyId(input), undefined, input);
	}
	assert.equal(normalizeToolOutputConfig({ expandLastKey: "alt+/" }).expandLastKey, "alt+/");
	assert.equal(normalizeToolOutputConfig({ expandLastKey: "nonsense key" }).expandLastKey, "alt+o");
});

test("saveToolOutputConfig writes through a symlinked config file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-output-config-link-test-"));
	try {
		const shared = join(root, "dotfiles", "config.json");
		const link = join(root, "agent", "config.json");
		mkdirSync(join(root, "dotfiles"));
		mkdirSync(join(root, "agent"));
		writeFileSync(shared, "{}\n");
		symlinkSync(shared, link);

		const config = { ...normalizeToolOutputConfig({}), bashCollapsedLines: 3 };
		assert.deepEqual(saveToolOutputConfig(config, link), { success: true });
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(JSON.parse(readFileSync(shared, "utf8")).bashCollapsedLines, 3);
		assert.equal(loadToolOutputConfig(link).config.bashCollapsedLines, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the settings install.sh offers match the configuration defaults", () => {
	const { settings } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	for (const setting of settings) {
		assert.equal(setting.default, DEFAULT_TOOL_OUTPUT_CONFIG[setting.key], setting.key);
		if (setting.type === "choice") {
			const modes = setting.key === "bashOutputMode" ? BASH_OUTPUT_MODES : OUTPUT_MODES;
			assert.deepEqual(setting.choices, [...modes], setting.key);
		}
		if (setting.type === "integer") {
			assert.equal(normalizeToolOutputConfig({ [setting.key]: setting.min - 1 })[setting.key], setting.min, setting.key);
			assert.equal(normalizeToolOutputConfig({ [setting.key]: setting.max + 1 })[setting.key], setting.max, setting.key);
		}
	}
});
