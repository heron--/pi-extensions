/**
 * user-message extension
 *
 * The user's message in a house box: `╭ ● User ────╮`, rails, `╰────╯` — the
 * same box language as pi-recap's frame and pi-context-footer's prompt
 * frame, which this layout inspired in the first place.
 *
 * Mechanism: pi exports its native `UserMessageComponent`, and the only way
 * to restyle a built-in message is to patch that prototype's `render` — the
 * same seam the previous third-party box used. Unlike it, this renderer does
 * NOT re-implement the content: it renders the component's own child tree
 * (pi's `Box[Markdown]`, with its theme, transformers, and background) at
 * rail-to-rail width and wraps the rows in the box from ../lib/box.ts.
 * Markdown, colors, and message transforms therefore stay pi's — the box is
 * the only thing this extension draws. pi's OSC133 shell-integration zone
 * markers are re-wrapped around the box so terminal scrollback zones survive.
 *
 * Below MIN_BOX_WIDTH the native message renders untouched. Disable with
 * `/user-message off` (persisted); restore the native render on shutdown.
 *
 * Replaces the user-message box of the third-party `pi-tool-display` — turn
 * its `enableNativeUserMessageBox` off so one patch owns the prototype.
 */

import { getAgentDir, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CORNER_BL,
	CORNER_BR,
	CORNER_TL,
	CORNER_TR,
	groundRow,
	labelRuleRow,
	railVerbatim,
} from "../lib/box.ts";

/**
 * nf-fa-crow — the house bestiary grows a bird (spider, skull, flower, crow).
 * U+EDEA in Nerd Fonts v3's remapped FA range: verified present in the
 * terminal font's cmap and single-cell with visibleWidth().
 */
const ICON_USER = "\uedea";
const LABEL_USER = "User";
/** Below this the box cannot hold a rule plus its label: pi's native message. */
const MIN_BOX_WIDTH = 12;

/** pi's own shell-integration zone markers (from its native user-message render). */
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * The patched prototype shape. The original render is kept for the fallback
 * path and for restoring on shutdown.
 */
interface PatchedUserMessagePrototype {
	render: (width: number) => string[];
	__userMessageOriginalRender?: (width: number) => string[];
	__userMessagePatchedBy?: symbol;
}

/** The active theme, captured at session start; the render path reads it live. */
let theme: Theme | undefined;
let enabled = true;

/* -------------------------------------------------------------------------- */
/* Preference                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The persisted toggle, beside the other extensions' configs in pi's agent
 * directory — NOT under <agent dir>/extensions/, which resolves into this
 * repo through the install symlinks (see ../lib/thinking-colors.ts for the
 * same reasoning).
 */
function configFile(): string {
	return join(getAgentDir(), "pi-user-message", "config.json");
}

interface StoredConfig {
	enabled?: boolean;
}

function loadEnabledPreference(): boolean {
	try {
		const stored = JSON.parse(readFileSync(configFile(), "utf8")) as StoredConfig;
		if (typeof stored.enabled === "boolean") return stored.enabled;
	} catch {
		// No config yet, or unreadable: default on.
	}
	return true;
}

/** Persist the preference; returns false when the config file is not writable. */
function saveEnabledPreference(value: boolean): boolean {
	try {
		const file = configFile();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ enabled: value }, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/* The box                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The user message's own body, framed: the component's children render at
 * rail-to-rail width, so each returned line is exactly `width - 2` cells and
 * already carries pi's userMessageBg. Rails attach with no gutter — the
 * native body has one column of air inside its background already.
 */
function renderBoxed(this: UserMessageComponent, originalRender: (width: number) => string[], width: number): string[] {
	const w = Math.max(0, Math.floor(width));
	if (!enabled || w < MIN_BOX_WIDTH) return originalRender.call(this, w);
	// The theme is what styles the box; without it (before session_start) the
	// native render is honest, ours would be unstyled.
	if (!theme) return originalRender.call(this, w);

	// The native render wraps its lines with the OSC133 zone markers; the box
	// needs the body bare so the markers can wrap the BOX instead.
	const containerRender = Object.getPrototypeOf(UserMessageComponent.prototype) as PatchedUserMessagePrototype;
	const body = containerRender.render!.call(this, w - 2) as string[];
	if (body.length === 0) return originalRender.call(this, w);

	const rule = (text: string) => theme!.fg("accent", text);
	// Two spaces: the crow's glyph has tighter bearings than the recap's
	// supplementary-plane markers, and one space reads as a collision.
	const label = theme.bold(theme.fg("accent", `${ICON_USER}  ${LABEL_USER}`));
	// The whole box sits on the same ground as its content (groundRow keeps it
	// across the full resets pi's markdown and the OSC markers emit), so the
	// rules and rails read as part of the box, not stickers on a strip.
	const ground = (row: string) => groundRow(row, theme!.getBgAnsi("userMessageBg"));

	const rows = [
		// A blank row above the box, so it breathes against the previous entry.
		"",
		ground(
			labelRuleRow({
				width: w,
				paint: rule,
				cornerL: CORNER_TL,
				cornerR: CORNER_TR,
				label,
				side: "left",
				padLabel: true,
			}),
		),
		...body.map((line) => ground(railVerbatim({ line, paint: rule, padX: 0 }))),
		ground(labelRuleRow({ width: w, paint: rule, cornerL: CORNER_BL, cornerR: CORNER_BR })),
	];

	// pi's zone markers, moved out to the box: the shell-integration zones
	// then read the whole box as one user-input zone, exactly as the native
	// render marked its own block.
	rows[1] = OSC133_ZONE_START + rows[1];
	rows[rows.length - 1] += OSC133_ZONE_END + OSC133_ZONE_FINAL;
	return rows;
}

/* -------------------------------------------------------------------------- */
/* Patch lifecycle                                                             */
/* -------------------------------------------------------------------------- */

function patch(): void {
	const prototype = UserMessageComponent.prototype as PatchedUserMessagePrototype;
	if (typeof prototype.render !== "function") return;
	if (prototype.__userMessagePatchedBy === PATCH_OWNER) return;
	// Keep the first-seen original: re-patching (session reload) must not
	// chain our own wrapper onto itself.
	if (!prototype.__userMessageOriginalRender) {
		prototype.__userMessageOriginalRender = prototype.render;
	}
	const originalRender = prototype.__userMessageOriginalRender;
	const wrapper = function (this: UserMessageComponent, width: number): string[] {
		return renderBoxed.call(this, originalRender, width);
	};
	installedWrapper = wrapper;
	prototype.render = wrapper;
	prototype.__userMessagePatchedBy = PATCH_OWNER;
}

/** The wrapper currently installed on the prototype, so unpatch can recognize it. */
let installedWrapper: ((width: number) => string[]) | undefined;

function unpatch(): void {
	const prototype = UserMessageComponent.prototype as PatchedUserMessagePrototype;
	// Ownership-safe restore: only when OUR wrapper is still the installed
	// render. Another extension may have chained on top (its original points at
	// our wrapper) — restoring underneath it would break its restore chain, so
	// in that case we leave the prototype untouched and drop only our reference.
	if (installedWrapper && prototype.render === installedWrapper) {
		const originalRender = prototype.__userMessageOriginalRender;
		if (typeof originalRender === "function") prototype.render = originalRender;
		delete prototype.__userMessageOriginalRender;
		delete prototype.__userMessagePatchedBy;
	}
	installedWrapper = undefined;
}

const PATCH_OWNER = Symbol("pi-user-message");

/* -------------------------------------------------------------------------- */
/* Extension entry                                                             */
/* -------------------------------------------------------------------------- */

export default function userMessageExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		enabled = loadEnabledPreference();
		theme = ctx.ui.theme;
		patch();
	});

	// Reloads reuse the session_start path; shutdowns hand the prototype back.
	pi.on("session_shutdown", () => {
		unpatch();
		theme = undefined;
	});

	pi.registerCommand("user-message", {
		description: "Toggle the boxed user message",
		handler: async (args, ctx) => {
			const verb = (args ?? "").trim().toLowerCase();
			if (verb !== "" && verb !== "on" && verb !== "off") {
				ctx.ui.notify("Usage: /user-message [on|off]", "warning");
				return;
			}
			if (verb !== "") enabled = verb === "on";
			ctx.ui.notify(
				verb === ""
					? `User message box is ${enabled ? "on" : "off"}`
					: saveEnabledPreference(enabled)
						? `User message box ${enabled ? "enabled" : "disabled"}`
						: `User message box ${enabled ? "enabled" : "disabled"} for this session only (config file not writable)`,
				"info",
			);
		},
	});
}
