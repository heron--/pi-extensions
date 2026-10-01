import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadToolOutputConfig, normalizeToolOutputConfig, saveToolOutputConfig } from "./config.ts";

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
