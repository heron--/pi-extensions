/**
 * The owner configuration in `<agent dir>/pi-context-footer/config.json`:
 * the layout and the hostname settings. Parsing is pure so it can be tested
 * without pi; reading the file is the one side effect, in readFooterConfig.
 *
 * The animate preference shares the file but is read through
 * lib/thinking-colors.ts, because the model picker reads it too.
 */

import { readFileSync } from "node:fs";

/** The four fixed places items can sit, in the frame's two rules. */
export const REGIONS = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;
export type Region = (typeof REGIONS)[number];

/** The finite set of items the footer implements itself. */
export const BUILTIN_ITEMS = [
	"model",
	"thinking",
	"directory",
	"context",
	"session-name",
	"hostname",
	"branch",
	"pull-request",
	"tokens",
] as const;
export type BuiltinItemId = (typeof BUILTIN_ITEMS)[number];

export interface BuiltinItem {
	kind: "builtin";
	id: BuiltinItemId;
}

/** A reference to one Pi status by its exact key. */
export interface StatusItem {
	kind: "status";
	key: string;
	/** Theme color the text is repainted in. */
	color: string;
}

export type LayoutItem = BuiltinItem | StatusItem;
export type Layout = Readonly<Record<Region, readonly LayoutItem[]>>;

/** The shipped layout, in the same form an owner writes it. */
export const DEFAULT_LAYOUT_CONFIG = {
	topLeft: ["model", "thinking", "directory", "context"],
	topRight: ["session-name"],
	bottomLeft: ["hostname"],
	bottomRight: [
		"branch",
		"pull-request",
		"tokens",
		{ status: "background-tasks", color: "accent" },
		{ status: "write-lock", color: "warning" },
	],
} as const;

const DEFAULT_STATUS_COLOR = "accent";
const STATUS_ITEM_KEYS = new Set(["status", "color"]);

/** Whether a theme defines a color; injected so parsing does not need a live theme. */
export type ColorCheck = (name: string) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseItem(value: unknown, where: string, isColor: ColorCheck, problems: string[]): LayoutItem | null {
	if (typeof value === "string") {
		if ((BUILTIN_ITEMS as readonly string[]).includes(value)) return { kind: "builtin", id: value as BuiltinItemId };
		problems.push(`${where}: unknown built-in item "${value}"`);
		return null;
	}
	if (!isRecord(value)) {
		problems.push(`${where}: an item must be a built-in item name or a { "status": ... } object`);
		return null;
	}
	if (!("status" in value)) {
		problems.push(`${where}: an item object needs "status"`);
		return null;
	}
	const unknown = Object.keys(value).filter((key) => !STATUS_ITEM_KEYS.has(key));
	if (unknown.length > 0) {
		problems.push(`${where}: unknown option ${unknown.map((key) => `"${key}"`).join(", ")}`);
		return null;
	}
	const { status, color } = value;
	if (typeof status !== "string" || status.length === 0) {
		problems.push(`${where}: "status" must be a non-empty string`);
		return null;
	}
	if (color !== undefined && (typeof color !== "string" || !isColor(color))) {
		problems.push(`${where}: "color" must be a theme color name`);
		return null;
	}
	return { kind: "status", key: status, color: color ?? DEFAULT_STATUS_COLOR };
}

/**
 * Validate the `layout` key. Any problem rejects the whole layout (null), so
 * a half-applied layout never surprises the owner; the caller decides what to
 * fall back to. An absent key is the default layout, with no problem.
 */
export function parseLayout(value: unknown, isColor: ColorCheck = () => true): { layout: Layout | null; problems: string[] } {
	if (value === undefined) value = {};
	const problems: string[] = [];
	if (!isRecord(value)) return { layout: null, problems: ["\"layout\" must be an object"] };

	for (const key of Object.keys(value)) {
		if (!(REGIONS as readonly string[]).includes(key)) problems.push(`"layout.${key}" is not a region (${REGIONS.join(", ")})`);
	}

	const builtins = new Set<string>();
	const statusKeys = new Set<string>();
	const layout = {} as Record<Region, LayoutItem[]>;
	for (const region of REGIONS) {
		const raw: unknown = region in value ? value[region] : DEFAULT_LAYOUT_CONFIG[region];
		if (!Array.isArray(raw)) {
			problems.push(`"layout.${region}" must be an array`);
			continue;
		}
		layout[region] = [];
		raw.forEach((entry, index) => {
			const where = `"layout.${region}[${index}]"`;
			const item = parseItem(entry, where, isColor, problems);
			if (!item) return;
			// Built-in names and status keys are different kinds of reference, so
			// a status keyed "tokens" does not collide with the built-in item.
			const seen = item.kind === "builtin" ? builtins : statusKeys;
			const name = item.kind === "builtin" ? item.id : item.key;
			if (seen.has(name)) {
				problems.push(`${where}: ${item.kind === "builtin" ? "built-in item" : "status"} "${name}" is already selected`);
				return;
			}
			seen.add(name);
			layout[region].push(item);
		});
	}
	return problems.length > 0 ? { layout: null, problems } : { layout, problems };
}

export const DEFAULT_LAYOUT: Layout = parseLayout(undefined).layout!;

/**
 * The hostname item's settings, from the `hostname` key:
 *
 *   "hostname": {
 *     "show": true,
 *     "match": "^devbox-(.+)$",
 *     "nickname": "box $1",
 *     "nicknames": { "devbox-17.corp.example": "devbox" }
 *   }
 *
 * `match`, when set, decides on its own: the item is available exactly when
 * the pattern matches the machine's real hostname, whatever `show` says. That
 * is what lets one dotfiles-managed config show the name on remote boxes and
 * hide it on the laptop. Without it, `show` is the switch (default off).
 *
 * `nickname` is a label template expanded from `match`'s captures, which
 * covers machines whose names are not known in advance. An exact `nicknames`
 * entry wins over it.
 */
export interface HostnameSettings {
	show: boolean;
	match: RegExp | null;
	nickname: string | null;
	nicknames: Map<string, string>;
}

export const DEFAULT_HOSTNAME_SETTINGS: HostnameSettings = { show: false, match: null, nickname: null, nicknames: new Map() };

/**
 * Hostname settings keep whatever entries are valid: unlike the layout, a bad
 * nickname should not hide a hostname the owner asked to see.
 */
export function parseHostnameSettings(stored: unknown): { settings: HostnameSettings; problems: string[] } {
	if (stored === undefined) return { settings: DEFAULT_HOSTNAME_SETTINGS, problems: [] };
	if (!isRecord(stored)) return { settings: DEFAULT_HOSTNAME_SETTINGS, problems: ["\"hostname\" must be an object"] };

	const { show, match, nickname, nicknames } = stored;
	const problems: string[] = [];
	const settings: HostnameSettings = { show: show === true, match: null, nickname: null, nicknames: new Map() };
	if (show !== undefined && typeof show !== "boolean") problems.push("\"hostname.show\" must be true or false");

	if (typeof match === "string" && match.length > 0) {
		try {
			// Hostnames are case-insensitive, so the pattern is too.
			settings.match = new RegExp(match, "i");
		} catch {
			problems.push(`"hostname.match" is not a valid regex: ${match}`);
		}
	} else if (match !== undefined && match !== null && match !== "") {
		problems.push("\"hostname.match\" must be a string");
	}

	if (typeof nickname === "string" && nickname.trim()) {
		settings.nickname = nickname.trim();
		if (!settings.match) problems.push("\"hostname.nickname\" needs \"hostname.match\" to expand");
	} else if (nickname !== undefined && nickname !== null) {
		problems.push("\"hostname.nickname\" must be a non-empty string");
	}

	if (isRecord(nicknames)) {
		for (const [host, label] of Object.entries(nicknames)) {
			if (typeof label === "string" && label.trim()) {
				settings.nicknames.set(host.toLowerCase(), label.trim());
			} else {
				problems.push(`"hostname.nicknames.${host}" must be a non-empty string`);
			}
		}
	} else if (nicknames !== undefined) {
		problems.push("\"hostname.nicknames\" must be an object");
	}

	return { settings, problems };
}

export interface FooterConfigLoad {
	/** The valid layout, or null when the file's layout is unusable. */
	layout: Layout | null;
	/** The hostname settings, or null when the file itself is unusable. */
	hostname: HostnameSettings | null;
	/** Everything wrong with the file, for one warning. */
	problems: string[];
}

/** Read and validate the config file. A missing file is the defaults, silently. */
export function readFooterConfig(file: string, isColor?: ColorCheck): FooterConfigLoad {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { layout: DEFAULT_LAYOUT, hostname: DEFAULT_HOSTNAME_SETTINGS, problems: [] };
	}

	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return { layout: null, hostname: null, problems: ["config.json is not valid JSON"] };
	}
	if (!isRecord(stored)) return { layout: null, hostname: null, problems: ["config.json must hold an object"] };

	const layout = parseLayout(stored.layout, isColor);
	const hostname = parseHostnameSettings(stored.hostname);
	return { layout: layout.layout, hostname: hostname.settings, problems: [...layout.problems, ...hostname.problems] };
}
