/**
 * The extensions this checkout offers: every top-level directory whose
 * package.json declares `pi.extensions`, which is what makes it a pi package.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { settingProblem } from "./settings.mjs";

/** `{ extensions: [{ name, description, settings }], problems }`, sorted by name. */
export function discoverExtensions(repoRoot) {
	const extensions = [];
	const problems = [];
	for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const manifestPath = join(repoRoot, entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			problems.push(`${entry.name}/package.json is not valid JSON`);
			continue;
		}
		if (!Array.isArray(manifest?.pi?.extensions)) continue;
		const settings = readSettings(entry.name, manifest.settings, problems);
		extensions.push({ name: entry.name, description: summary(manifest.description), settings });
	}
	extensions.sort((a, b) => a.name.localeCompare(b.name));
	return { extensions, problems };
}

/** The manifest's settings, or none when any entry is unusable, with the reason recorded. */
function readSettings(name, declared, problems) {
	if (declared === undefined) return [];
	if (!Array.isArray(declared)) {
		problems.push(`${name}: "settings" must be a list`);
		return [];
	}
	const seen = new Set();
	for (const [index, entry] of declared.entries()) {
		const problem = settingProblem(entry) ?? (seen.has(entry.key) ? `${entry.key}: declared twice` : undefined);
		if (problem) {
			problems.push(`${name}: settings[${index}] ${problem}`);
			return [];
		}
		seen.add(entry.key);
	}
	return declared;
}

/** The package description without the "Pi extension:" prefix every manifest repeats. */
function summary(description) {
	if (typeof description !== "string") return "";
	const text = description.replace(/^pi extension:\s*/i, "").trim();
	return text.charAt(0).toUpperCase() + text.slice(1);
}
