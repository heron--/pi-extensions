/**
 * Built-in items and status items: each turns current data into display text,
 * or null when its data is unavailable. Nothing here knows where an item sits
 * or how wide the terminal is; that is layout.ts and the frame's business.
 */

import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { paintThinkingLevel } from "../lib/thinking-colors.ts";
import type { BuiltinItemId, HostnameSettings, LayoutItem } from "./config.ts";
import type { PullRequest } from "./pull-request.ts";

const ICON_MODEL = String.fromCodePoint(0xf068c);
const ICON_FOLDER = "";
const ICON_BRANCH = "";
const ICON_GAUGE = "";
const ICON_LOCK = String.fromCodePoint(0xf033e); // nf-md-lock
const ICON_LOCK_OPEN = String.fromCodePoint(0xf033f); // nf-md-lock_open
const ICON_SESSION = String.fromCodePoint(0xf04f9); // nf-md-tag
const ICON_HOST = ""; // nf-fa-server

const GAUGE_WIDTH = 8;
const GAUGE_FILLED = "█";
const GAUGE_EMPTY = "░";
const GAUGE_WARN_PERCENT = 60;
const GAUGE_ALERT_PERCENT = 85;

/** OSC 8: wraps a label so terminals treat it as a link to `url`. */
const LINK_OPEN = "\x1b]8;;";
const LINK_CLOSE = "\x1b]8;;\x07";

/** A CSI sequence, or an OSC/APC string up to its BEL or ST terminator. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** Everything an item may draw from, gathered once per render. */
export interface ItemData {
	ctx: Pick<ExtensionContext, "model" | "thinkingLevel" | "getContextUsage" | "sessionManager">;
	theme: Theme;
	branch: string | null;
	pullRequest: PullRequest | null;
	hostname: string;
	hostnameSettings: HostnameSettings;
	tokens: TokenTotals;
	statuses: ReadonlyMap<string, string>;
	/** Whether the thinking gloss is being driven by a repaint ticker. */
	animated: boolean;
}

/**
 * Paint in a theme color by name. Owner configuration names colors as
 * strings; a theme switched after the configuration was validated may not
 * define one, and `theme.fg` throws on an unknown color, which from a render
 * path tears the TUI down. Fall back to the accent color instead.
 */
export function paintColor(theme: Theme, color: string, text: string): string {
	try {
		return theme.fg(color as ThemeColor, text);
	} catch {
		return theme.fg("accent", text);
	}
}

export function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export interface TokenTotals {
	/** Cache-inclusive input tokens. */
	input: number;
	output: number;
}

/**
 * Token totals across the whole session: every usage pi records — assistant
 * responses, usage a tool reported for itself, the calls behind a compaction
 * or branch summary, and standalone usage entries such as cache warming —
 * the same entries pi's own usage breakdown counts. It walks every entry
 * rather than the active branch, because an abandoned branch's requests were
 * still made. Recorded usage is not proof of billing.
 *
 * Sessions written by older pi versions have no standalone usage entries, and
 * may lack optional usage fields; missing usage or fields count as zero.
 */
export function tokenTotals(entries: readonly SessionEntry[]): TokenTotals {
	const totals: TokenTotals = { input: 0, output: 0 };
	const add = (usage: Partial<Usage> | undefined) => {
		if (!usage) return;
		totals.input += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		totals.output += usage.output ?? 0;
	};
	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
			add(entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant" || entry.message.role === "toolResult") add(entry.message.usage);
	}
	return totals;
}

/**
 * Token totals, recomputed only when the session or its leaf changes.
 * `getEntries()` copies the whole session and every frame redraws, so walking
 * it per render scales with the transcript. Every append moves the leaf, so
 * the leaf id is a sound change marker; one cached result is enough.
 */
export function createTokenTotalsCache(): (sessionManager: ItemData["ctx"]["sessionManager"]) => TokenTotals {
	let key: string | null = null;
	let cached: TokenTotals = { input: 0, output: 0 };
	return (sessionManager) => {
		const next = `${sessionManager.getSessionId()}\0${sessionManager.getLeafId() ?? ""}`;
		if (next !== key) {
			cached = tokenTotals(sessionManager.getEntries());
			key = next;
		}
		return cached;
	};
}

function gaugeColor(percent: number): "success" | "warning" | "error" {
	if (percent >= GAUGE_ALERT_PERCENT) return "error";
	if (percent >= GAUGE_WARN_PERCENT) return "warning";
	return "success";
}

function renderGauge(theme: Theme, percent: number | null): string {
	if (percent === null) return theme.fg("dim", GAUGE_EMPTY.repeat(GAUGE_WIDTH));

	const clamped = Math.max(0, Math.min(100, percent));
	const filledCount = Math.round((clamped / 100) * GAUGE_WIDTH);
	return theme.fg(gaugeColor(clamped), GAUGE_FILLED.repeat(filledCount))
		+ theme.fg("dim", GAUGE_EMPTY.repeat(GAUGE_WIDTH - filledCount));
}

/**
 * The thinking-level label, painted with the shared scheme from
 * lib/thinking-colors.ts so it matches the model picker's level rows exactly —
 * except "off", which paints dim rather than the scheme's thinkingOff color.
 * Themes may map that color to rule shades meant for barely-visible
 * separators, and the frame itself is not thinking-tinted, so this label is
 * the off state's only announcement and has to stay legible. The model
 * picker's DeepSeek toggle rows paint "off" dim for the same reason.
 */
function thinkingLabel(theme: Theme, level: ModelThinkingLevel, animated: boolean): string {
	if (level === "off") return theme.fg("dim", `thinking:${level}`);
	return paintThinkingLevel(theme, level, `thinking:${level}`, animated);
}

/**
 * The identity labels' paint — the session name and the hostname.
 * `emphasisText` is a theme color pi's ThemeColor union does not know about,
 * defined by the frontier-funds theme; others fall back to the accent color.
 */
function paintIdentity(theme: Theme, text: string): string {
	return paintColor(theme, "emphasisText", text);
}

/** Whether the hostname is shown: the regex decides when there is one, else the switch. */
export function hostnameShown(settings: HostnameSettings, host: string): boolean {
	if (!host) return false;
	return settings.match ? settings.match.test(host) : settings.show;
}

/**
 * Expand a `nickname` template against a match of `hostname.match`, with
 * String.prototype.replace's reference syntax: `$1`…`$99` for numbered
 * groups, `$<name>` for named groups, `$&` for the whole match, and `$$` for a
 * literal dollar sign. A reference to a group that did not participate
 * expands to nothing; anything else after `$` is kept as written.
 */
function expandNickname(template: string, match: RegExpMatchArray): string {
	return template.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (whole, token: string, name?: string, index?: string) => {
		if (token === "$") return "$";
		if (token === "&") return match[0];
		if (name !== undefined) return match.groups && name in match.groups ? (match.groups[name] ?? "") : whole;
		const group = Number(index);
		return group > 0 && group < match.length ? (match[group] ?? "") : whole;
	});
}

/**
 * The label for `host`, first of:
 *
 * - its entry in `nicknames`, looked up by the full name and then by its
 *   first label (`devbox-17` for `devbox-17.corp.example`), case-insensitively;
 * - the `nickname` template expanded from `match`'s captures, when the pattern
 *   matches and the expansion is not blank;
 * - the hostname itself.
 */
export function hostnameLabel(settings: HostnameSettings, host: string): string {
	const full = host.toLowerCase();
	const short = full.split(".")[0] ?? full;
	const exact = settings.nicknames.get(full) ?? settings.nicknames.get(short);
	if (exact) return exact;
	if (settings.nickname && settings.match) {
		const match = host.match(settings.match);
		const label = match ? expandNickname(settings.nickname, match).trim() : "";
		if (label) return label;
	}
	return host;
}

function renderBuiltin(id: BuiltinItemId, data: ItemData): string | null {
	const { ctx, theme } = data;
	switch (id) {
		case "model": {
			const model = ctx.model?.name || ctx.model?.id || "no-model";
			return theme.fg("syntaxType", `${ICON_MODEL} ${model}`);
		}
		case "thinking":
			if (!ctx.model?.reasoning || !ctx.thinkingLevel) return null;
			return thinkingLabel(theme, ctx.thinkingLevel, data.animated);
		case "directory": {
			const cwd = ctx.sessionManager.getCwd();
			return theme.fg("syntaxFunction", `${ICON_FOLDER} ${basename(cwd) || cwd}`);
		}
		case "context": {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const percent = usage?.percent ?? null;
			const percentLabel = percent === null ? "?" : `${percent.toFixed(0)}%`;
			const tone = percent === null ? "dim" : gaugeColor(percent);
			return `${theme.fg(tone, ICON_GAUGE)} ${renderGauge(theme, percent)} ${theme.fg("text", `${percentLabel}/${formatTokens(contextWindow)}`)}`;
		}
		case "session-name": {
			const name = ctx.sessionManager.getSessionName();
			return name ? paintIdentity(theme, `${ICON_SESSION} ${name}`) : null;
		}
		case "hostname":
			if (!hostnameShown(data.hostnameSettings, data.hostname)) return null;
			return paintIdentity(theme, `${ICON_HOST} ${hostnameLabel(data.hostnameSettings, data.hostname)}`);
		case "branch":
			return data.branch ? theme.fg("success", `${ICON_BRANCH} ${data.branch}`) : null;
		case "pull-request": {
			const pullRequest = data.pullRequest;
			if (!pullRequest) return null;
			return `${LINK_OPEN}${pullRequest.url}\x07${theme.fg("mdLink", `#${pullRequest.number}`)}${LINK_CLOSE}`;
		}
		case "tokens": {
			const { input, output } = data.tokens;
			if (!input && !output) return null;
			return theme.fg("syntaxNumber", `⇡${formatTokens(input)} ⇣${formatTokens(output)}`);
		}
	}
}

/** One item's display text, or null when its data is unavailable. */
export function renderItem(item: LayoutItem, data: ItemData): string | null {
	if (item.kind === "builtin") return renderBuiltin(item.id, data);

	const published = data.statuses.get(item.key);
	if (published === undefined) return null;
	// Statuses arrive pre-styled for pi's own footer — pi-background-tasks
	// ships a filled light-blue pill. Strip that and repaint so a status
	// reads as part of this border rather than a sticker on it.
	const plain = stripAnsi(published).trim();
	if (!plain) return null;
	if (item.key === "write-lock") {
		// The published text (`write unlocked`) contains "locked", so the
		// open-lock test has to win.
		const icon = /unlock/i.test(plain) ? ICON_LOCK_OPEN : ICON_LOCK;
		return paintColor(data.theme, item.color, `${icon} ${plain}`);
	}
	return paintColor(data.theme, item.color, plain);
}

/** A stable id for visibility checks: a built-in name, or `status:<key>`. */
export function itemId(item: LayoutItem): string {
	return item.kind === "builtin" ? item.id : `status:${item.key}`;
}
