/** Owner-supplied, synchronous status display functions, loaded outside render. */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeStatus, type Presentation } from "./status.ts";

export type StatusFormatter = (text: string) => string | null | undefined;
export type StatusFormatters = ReadonlyMap<string, StatusFormatter>;

let revision = 0;
// Pi's TypeScript loader rewrites import(). Keep the native importer in a
// Node-loaded module so URL queries retain their cache-busting semantics.
const importModule = createRequire(import.meta.url)("./import-module.cjs") as (url: string) => Promise<{ default: unknown }>;

/** Paths are relative to config.json; absolute paths and ~/ are also accepted. */
export async function loadStatusFormatters(path: string | null, configFile: string): Promise<StatusFormatters> {
	if (path === null) return new Map();
	const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
	const url = pathToFileURL(resolve(dirname(configFile), expanded));
	// Each explicit reload evaluates the entry module again, even at the same path.
	url.searchParams.set("revision", `${Date.now()}-${++revision}`);
	const { default: exported } = await importModule(url.href);
	if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
		throw new Error("statusFormatters module must default-export an object of functions");
	}
	const formatters = new Map<string, StatusFormatter>();
	for (const [key, formatter] of Object.entries(exported)) {
		if (!key || typeof formatter !== "function") {
			throw new Error("statusFormatters entries must have non-empty keys and function values");
		}
		formatters.set(key, formatter as StatusFormatter);
	}
	return formatters;
}

/** Missing, declining, failed or invalid formatters leave the sanitized text alone. */
export function formatStatus(key: string, published: string, presentation: Presentation, formatters: StatusFormatters): string {
	const text = sanitizeStatus(published, presentation);
	const formatter = formatters.get(key);
	if (!text || !formatter) return text;
	try {
		const result: unknown = formatter(text);
		// Async callbacks are not part of the contract; don't let a rejected
		// promise become an unhandled rejection while falling back to the text.
		if (result instanceof Promise) void result.catch(() => {});
		return typeof result === "string" ? sanitizeStatus(result, presentation) : text;
	} catch {
		return text;
	}
}
