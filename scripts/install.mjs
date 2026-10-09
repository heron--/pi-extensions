#!/usr/bin/env node
/**
 * The installer that ./install.sh runs. It links the extensions the user picks
 * into pi's global extension directory, offers to install the npm packages
 * they share, then offers each linked extension's settings
 * (see install/settings.mjs).
 *
 * Re-running is safe: the menu starts from what is linked, correct links are
 * left alone, and anything that would remove or replace a link asks first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverExtensions } from "./install/catalog.mjs";
import { LIB, createLink, inspectLink, planLinks, relink, unlinkSymlink } from "./install/links.mjs";
import { agentDirectory, displayPath } from "./install/paths.mjs";
import {
	configPath,
	currentValue,
	describeAllowed,
	formatValue,
	parseAnswer,
	readConfig,
	writeConfig,
} from "./install/settings.mjs";
import { createPrompter, createStyle, selectFromList } from "./install/terminal.mjs";

const USAGE = `Usage: ./install.sh

Choose which of this checkout's pi extensions to link into pi's extension
directory, <agent dir>/extensions, then customize their settings. <agent dir>
is $PI_CODING_AGENT_DIR when set, otherwise ~/.pi/agent.

Run it again to change the selection. Links of extensions you deselect are
removed after you confirm.`;

const args = process.argv.slice(2);
if (args.some((arg) => arg === "-h" || arg === "--help")) {
	console.log(USAGE);
	process.exit(0);
}
if (args.length > 0) {
	console.error(`Unknown argument: ${args[0]}\n\n${USAGE}`);
	process.exit(2);
}

const { stdin: input, stdout: output } = process;
if (!input.isTTY || !output.isTTY) {
	console.error("install.sh is interactive: run it in a terminal.");
	process.exit(1);
}

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const agentDir = agentDirectory();
const extensionsDir = join(agentDir, "extensions");
const style = createStyle(!process.env.NO_COLOR);
const interrupt = () => process.exit(130);

const { extensions, problems } = discoverExtensions(repoRoot);
for (const problem of problems) console.log(style.yellow(`warning: ${problem}`));
if (extensions.length === 0) {
	console.error(`No extensions found in ${displayPath(repoRoot)}.`);
	process.exit(1);
}

/* ---------------------------------------------------------------- choose */

const NOTES = { dangling: "broken link", elsewhere: "linked from elsewhere" };
const items = extensions.map(({ name, description }) => {
	const link = inspectLink(join(extensionsDir, name), join(repoRoot, name));
	const note = link.state === "occupied" ? `blocked by a ${link.kind}` : NOTES[link.state];
	return { name, description, note, checked: link.state === "ok" };
});

const selected = await selectFromList({
	input,
	output,
	style,
	title: "pi-extensions installer",
	subtitle: `Links go into ${displayPath(extensionsDir)}`,
	items,
	onInterrupt: interrupt,
});
if (!selected) {
	console.log("Cancelled — nothing changed.");
	process.exit(1);
}
console.log(`Selected: ${selected.length ? selected.join(", ") : "none"}`);

/* ----------------------------------------------------------------- links */

const plan = planLinks({
	repoRoot,
	extensionsDir,
	names: extensions.map(({ name }) => name),
	selected: new Set(selected),
	hasLib: existsSync(join(repoRoot, LIB)),
});
const prompter = createPrompter({ input, output, onInterrupt: interrupt });

let { replace, remove } = plan;
if (replace.length > 0) {
	console.log("\nThese links point somewhere other than this checkout:");
	for (const change of replace) console.log(`  ${change.name} → ${change.current}`);
	if (!(await prompter.confirm("Replace them?"))) {
		if (replace.some((change) => change.name === LIB)) {
			console.log(style.yellow(`  Extensions linked from this checkout will import ${LIB} from the other location.`));
		}
		replace = [];
	}
}

const REASONS = {
	deselected: "not selected",
	unused: "no selected extension needs it",
	broken: "points to a path this checkout no longer has",
};
if (remove.length > 0) {
	console.log("\nThese links are no longer needed:");
	for (const change of remove) console.log(`  ${change.name}  ${style.dim(REASONS[change.reason])}`);
	if (!(await prompter.confirm("Remove them?"))) remove = [];
}

let changed = false;
const apply = (verb, change, action) => {
	try {
		action(change);
		console.log(`  ${style.green(verb.padEnd(8))} ${change.name}`);
		changed = true;
	} catch (error) {
		console.log(`  ${style.red("failed".padEnd(8))} ${change.name}: ${error.message}`);
	}
};
console.log("");
for (const change of remove) apply("removed", change, () => unlinkSymlink(change.linkPath));
for (const change of [...plan.repair, ...replace]) apply("relinked", change, relink);
for (const change of plan.create) apply("linked", change, createLink);
for (const change of plan.blocked) {
	console.log(`  ${style.yellow("skipped".padEnd(8))} ${change.name}: a real ${change.kind} is in the way at ${displayPath(change.linkPath)}`);
}
if (!changed && plan.blocked.length === 0) console.log("Links are already up to date.");

const linked = extensions.filter(
	({ name }) => inspectLink(join(extensionsDir, name), join(repoRoot, name)).state === "ok",
);

/* ---------------------------------------------------------- dependencies */

/** The root package's runtime dependencies that node_modules lacks. */
function missingDependencies() {
	const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const installed = (name) => existsSync(join(repoRoot, "node_modules", name, "package.json"));
	return {
		missing: Object.keys(manifest.dependencies ?? {}).filter((name) => !installed(name)),
		// `--omit=dev` would delete development dependencies already installed.
		developing: Object.keys(manifest.devDependencies ?? {}).some(installed),
	};
}

if (linked.length > 0) {
	const { missing, developing } = missingDependencies();
	if (missing.length > 0) {
		const npmArgs = developing ? ["install"] : ["install", "--omit=dev"];
		const command = `npm ${npmArgs.join(" ")}`;
		console.log(`\nThe extensions share npm packages that are not installed: ${missing.join(", ")}.`);
		if (await prompter.confirm(`Install them with \`${command}\`?`, true)) {
			const result = prompter.suspended(() => spawnSync("npm", npmArgs, { cwd: repoRoot, stdio: "inherit" }));
			if (result.error || result.status !== 0) {
				const reason = result.error ? `could not run npm (${result.error.code ?? result.error.message})` : `npm exited with status ${result.status}`;
				console.log(style.yellow(`  ${reason}. Run \`${command}\` in ${displayPath(repoRoot)} to retry.`));
			} else {
				changed = true;
			}
		}
	}
}

/* -------------------------------------------------------------- settings */

/** Ask each of an extension's settings in turn and save the answers that change something. */
async function customize({ name, settings }) {
	const path = configPath(agentDir, name);
	const read = readConfig(path);
	if (read.error) {
		console.log(style.yellow(`  ${displayPath(path)} ${read.error}. Fix it, then run install.sh again.`));
		return;
	}
	console.log(style.dim(`  Press Enter to keep a value. ${name}/README.md describes every setting.`));
	const changes = [];
	for (const setting of settings) {
		const current = currentValue(setting, read.config);
		for (;;) {
			const answer = await prompter.ask(
				`  ${setting.prompt} (${describeAllowed(setting)}) [${formatValue(setting, current)}]: `,
			);
			if (answer === null) return;
			const parsed = parseAnswer(setting, answer);
			if (parsed.error) {
				console.log(style.yellow(`    ${parsed.error}`));
				continue;
			}
			if (!parsed.keep && parsed.value !== current) changes.push([setting.key, parsed.value]);
			break;
		}
	}
	if (changes.length === 0) {
		console.log("  No changes.");
		return;
	}
	const result = writeConfig(path, changes);
	if (result.error) {
		console.log(style.red(`  ${result.error}`));
		return;
	}
	console.log(`  Saved ${changes.map(([key]) => key).join(", ")} to ${displayPath(path)}`);
	changed = true;
}

for (const extension of linked.filter(({ settings }) => settings.length > 0)) {
	console.log("");
	if (await prompter.confirm(`Customize ${extension.name} settings?`)) await customize(extension);
}

prompter.close();
console.log(changed ? "\nDone. Start pi, or run /reload in a running session, to load the changes." : "\nNothing changed.");
