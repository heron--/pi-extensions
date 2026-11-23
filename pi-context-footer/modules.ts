/**
 * Footer modules: owner-supplied JavaScript that turns pi events and published
 * statuses into footer content. A module groups everything one concern needs —
 * the events it listens to, the statuses it draws, and the state it keeps
 * between them — so a status can show data its producer only sends as events.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeStatus, type Presentation } from "./status.ts";

/** What every handler is given about the session it runs in. */
export interface ModuleContext {
	sessionId: string;
}

/**
 * Draws one status key. `text` is the sanitized published status, or
 * undefined while nothing is published under the key. A string replaces it,
 * `""` hides it, and anything else keeps the published text.
 */
export type StatusHandler = (text: string | undefined, context: ModuleContext) => unknown;
/** Receives one pi event channel's payload; the footer redraws after it. */
export type EventHandler = (data: unknown, context: ModuleContext) => unknown;

export interface FooterModule {
	/** The module's file name, for messages. */
	name: string;
	statuses: ReadonlyMap<string, StatusHandler>;
	events: ReadonlyMap<string, EventHandler>;
}

/** Loaded modules, with each status key's handler looked up across all of them. */
export interface FooterModules {
	modules: readonly FooterModule[];
	statuses: ReadonlyMap<string, { module: string; handler: StatusHandler }>;
}

export const NO_MODULES: FooterModules = { modules: [], statuses: new Map() };

/** pi's event bus: `on` returns the unsubscribe function. */
export interface EventSource {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

const MODULE_KEYS = new Set(["statuses", "events"]);

let revision = 0;
// Pi's TypeScript loader rewrites import(). Keep the native importer in a
// Node-loaded module so URL queries retain their cache-busting semantics.
const importModule = createRequire(import.meta.url)("./import-module.cjs") as (url: string) => Promise<{ default: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function handlers<T>(exported: Record<string, unknown>, field: string, name: string): Map<string, T> {
	const value = exported[field];
	const map = new Map<string, T>();
	if (value === undefined) return map;
	if (!isRecord(value)) throw new Error(`module ${name}: "${field}" must be an object of functions`);
	for (const [key, handler] of Object.entries(value)) {
		if (!key || typeof handler !== "function") {
			throw new Error(`module ${name}: "${field}" entries must have non-empty keys and function values`);
		}
		map.set(key, handler as T);
	}
	return map;
}

async function loadModule(path: string, configFile: string): Promise<FooterModule> {
	const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
	const file = resolve(dirname(configFile), expanded);
	const name = basename(file);
	const url = pathToFileURL(file);
	// Each load evaluates the module again, even at the same path, so a reload
	// or a new session starts it with fresh state.
	url.searchParams.set("revision", `${Date.now()}-${++revision}`);
	const { default: exported } = await importModule(url.href);
	if (!isRecord(exported)) throw new Error(`module ${name} must default-export an object`);
	const unknown = Object.keys(exported).filter((key) => !MODULE_KEYS.has(key));
	if (unknown.length > 0) throw new Error(`module ${name}: unknown export ${unknown.map((key) => `"${key}"`).join(", ")}`);
	return {
		name,
		statuses: handlers<StatusHandler>(exported, "statuses", name),
		events: handlers<EventHandler>(exported, "events", name),
	};
}

/**
 * Load every module, or none: any failure rejects, so the caller keeps what it
 * had. Paths are relative to config.json; absolute paths and ~/ also work. Two
 * modules may listen to the same event but not draw the same status.
 */
export async function loadModules(paths: readonly string[], configFile: string): Promise<FooterModules> {
	const modules: FooterModule[] = [];
	const statuses = new Map<string, { module: string; handler: StatusHandler }>();
	for (const path of paths) {
		const loaded = await loadModule(path, configFile);
		for (const [key, handler] of loaded.statuses) {
			const owner = statuses.get(key);
			if (owner) throw new Error(`modules ${owner.module} and ${loaded.name} both draw status "${key}"`);
			statuses.set(key, { module: loaded.name, handler });
		}
		modules.push(loaded);
	}
	return { modules, statuses };
}

/**
 * Subscribe the modules' event handlers. A handler's failure is swallowed:
 * pi's bus would print it over the TUI. Returns the unsubscribe function.
 */
export function subscribeModules(loaded: FooterModules, events: EventSource, context: () => ModuleContext, changed: () => void): () => void {
	const unsubscribers: (() => void)[] = [];
	for (const module of loaded.modules) {
		for (const [channel, handler] of module.events) {
			unsubscribers.push(events.on(channel, (data) => {
				try {
					const result = handler(data, context());
					if (result instanceof Promise) void result.catch(() => {});
				} catch {
					// A module's bug must not reach the terminal or other listeners.
				}
				changed();
			}));
		}
	}
	return () => unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
}

/**
 * The text drawn for a status key: the module's rendering when one handles
 * it, else the sanitized published text. A missing, declining, failed or
 * invalid handler leaves the published text alone. Returns "" for nothing.
 */
export function statusText(
	key: string,
	published: string | undefined,
	presentation: Presentation,
	loaded: FooterModules,
	context: ModuleContext,
): string {
	const text = published === undefined ? "" : sanitizeStatus(published, presentation);
	const owner = loaded.statuses.get(key);
	if (!owner) return text;
	try {
		const result: unknown = owner.handler(text || undefined, context);
		// Handlers are synchronous; don't let a rejected promise become an
		// unhandled rejection while falling back to the text.
		if (result instanceof Promise) void result.catch(() => {});
		return typeof result === "string" ? sanitizeStatus(result, presentation) : text;
	} catch {
		return text;
	}
}
