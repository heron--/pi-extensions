/**
 * The settings an extension offers through the installer, and the
 * `config.json` they are written to.
 *
 * An extension declares them under `settings` in its package.json. Each entry
 * describes one key of `<agent dir>/<extension>/config.json`:
 *
 *   { "key": "hostname.show", "prompt": "Show the hostname", "type": "boolean", "default": false }
 *
 * - `key`: a dotted path into config.json.
 * - `prompt`: the question the installer asks.
 * - `type`: `boolean`; `choice`, with `choices`, a list of strings; `number`
 *   or `integer`, with optional `min` and `max`; or `string`.
 * - `default`: the value the extension uses when the key is absent. The
 *   extension's tests keep it equal to the code's default.
 *
 * Only settings that a single answer can express belong here; anything
 * structured stays documented in the extension's README.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTING_TYPES = ["boolean", "choice", "number", "integer", "string"];

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is one the setting accepts. */
export function isValidValue(setting, value) {
	switch (setting.type) {
		case "boolean":
			return typeof value === "boolean";
		case "choice":
			return setting.choices.includes(value);
		case "number":
		case "integer":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				(setting.type === "number" || Number.isInteger(value)) &&
				(setting.min === undefined || value >= setting.min) &&
				(setting.max === undefined || value <= setting.max)
			);
		case "string":
			return typeof value === "string" && value.length > 0;
		default:
			return false;
	}
}

/** Why `entry` is not a usable setting, or undefined when it is one. */
export function settingProblem(entry) {
	if (!isRecord(entry)) return "must be an object";
	if (typeof entry.key !== "string" || !KEY_PATTERN.test(entry.key)) return "\"key\" must be a dotted path such as \"hostname.show\"";
	if (typeof entry.prompt !== "string" || !entry.prompt.trim()) return `${entry.key}: "prompt" must be a non-empty string`;
	if (!SETTING_TYPES.includes(entry.type)) return `${entry.key}: "type" must be one of ${SETTING_TYPES.join(", ")}`;
	if (entry.type === "choice") {
		const { choices } = entry;
		if (!Array.isArray(choices) || choices.length < 2 || !choices.every((choice) => typeof choice === "string" && choice)) {
			return `${entry.key}: "choices" must list at least two strings`;
		}
		if (new Set(choices.map((choice) => choice.toLowerCase())).size !== choices.length) {
			return `${entry.key}: "choices" must differ by more than case`;
		}
	}
	if (entry.type === "number" || entry.type === "integer") {
		for (const bound of ["min", "max"]) {
			if (entry[bound] !== undefined && (typeof entry[bound] !== "number" || !Number.isFinite(entry[bound]))) {
				return `${entry.key}: "${bound}" must be a number`;
			}
		}
		if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) return `${entry.key}: "min" exceeds "max"`;
	}
	if (!isValidValue(entry, entry.default)) return `${entry.key}: "default" is not a value the setting accepts`;
	return undefined;
}

/** The values a setting accepts, as shown beside its prompt. */
export function describeAllowed(setting) {
	switch (setting.type) {
		case "boolean":
			return "yes, no";
		case "choice":
			return setting.choices.join(", ");
		case "number":
		case "integer": {
			const kind = setting.type === "integer" ? "whole number" : "number";
			if (setting.min !== undefined && setting.max !== undefined) return `${setting.min}–${setting.max}`;
			if (setting.min !== undefined) return `${kind} ≥ ${setting.min}`;
			if (setting.max !== undefined) return `${kind} ≤ ${setting.max}`;
			return kind;
		}
		default:
			return "text";
	}
}

export function formatValue(setting, value) {
	if (setting.type === "boolean") return value ? "yes" : "no";
	return String(value);
}

/**
 * Interpret one typed answer. An empty answer keeps the current value;
 * otherwise the result is the new value or the reason it was refused.
 */
export function parseAnswer(setting, answer) {
	const text = answer.trim();
	if (!text) return { keep: true };
	let value;
	switch (setting.type) {
		case "boolean":
			if (/^(y|yes|true|on)$/i.test(text)) value = true;
			else if (/^(n|no|false|off)$/i.test(text)) value = false;
			else return { error: "Answer yes or no." };
			break;
		case "choice":
			value = setting.choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
			if (value === undefined) return { error: `Choose one of: ${setting.choices.join(", ")}.` };
			break;
		case "number":
		case "integer":
			value = Number(text);
			if (!Number.isFinite(value)) return { error: `Enter a ${setting.type === "integer" ? "whole number" : "number"}.` };
			break;
		default:
			value = text;
	}
	if (!isValidValue(setting, value)) return { error: `Enter a value in ${describeAllowed(setting)}.` };
	return { value };
}

export function getPath(object, key) {
	let value = object;
	for (const part of key.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[part];
	}
	return value;
}

/** Set a dotted key, creating missing objects; refuses to replace a non-object on the way. */
export function setPath(object, key, value) {
	const parts = key.split(".");
	let parent = object;
	for (const [index, part] of parts.slice(0, -1).entries()) {
		if (parent[part] === undefined) parent[part] = {};
		if (!isRecord(parent[part])) throw new Error(`"${parts.slice(0, index + 1).join(".")}" is not an object`);
		parent = parent[part];
	}
	parent[parts.at(-1)] = value;
}

/** The value the extension uses now: the stored one when it is valid, else the default. */
export function currentValue(setting, config) {
	const stored = getPath(config, setting.key);
	return isValidValue(setting, stored) ? stored : setting.default;
}

export function configPath(agentDir, extensionName) {
	return join(agentDir, extensionName, "config.json");
}

/**
 * Read a config file. A missing file is an empty config; one that does not
 * parse to an object is an error, so a hand edit in progress is never
 * overwritten.
 */
export function readConfig(path) {
	if (!existsSync(path)) return { config: {} };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { error: "is not valid JSON" };
	}
	return isRecord(parsed) ? { config: parsed } : { error: "does not hold a JSON object" };
}

/**
 * Apply `changes` (`[key, value]` pairs) to the file as it is now, keeping
 * every other key. A symlinked file is updated at its target, so a config
 * shared through a link stays shared.
 */
export function writeConfig(path, changes) {
	const read = readConfig(path);
	if (read.error) return { error: `${path} ${read.error}` };
	try {
		for (const [key, value] of changes) setPath(read.config, key, value);
	} catch (error) {
		return { error: `${path}: ${error.message}` };
	}
	mkdirSync(dirname(path), { recursive: true });
	const target = existsSync(path) ? realpathSync(path) : path;
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(read.config, null, 2)}\n`, "utf8");
		renameSync(temporary, target);
		return {};
	} catch (error) {
		return { error: `Could not write ${path}: ${error.message}` };
	} finally {
		rmSync(temporary, { force: true });
	}
}
