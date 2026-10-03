/**
 * The grouped layout: neighbouring tool calls share one house box.
 *
 * Pi renders each tool call as its own `ToolExecutionComponent`, a sibling in
 * the chat container, and a renderer only ever sees its own call. So grouping
 * happens one level up, at the component's `render`: each member finds its
 * siblings, and the first member of a run (the leader) draws the whole run
 * while the others (followers) draw nothing. A row that renders nothing — the
 * empty assistant message between two tool-only turns — does not break a run;
 * anything that renders a row does.
 *
 * The collapsed view shows one row per call — name, summary, and the size of
 * its output — with no output body. Expansion is per call (pi's own
 * `expanded` flag on each component), so Ctrl+O, a click on a row, and the
 * expand-last shortcut all toggle the same state.
 */

import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { compactArguments } from "./arguments.ts";
import { callArgumentsComponent, paintSummary } from "./call-rendering.ts";
import { paint, TOOL_OUTPUT_COLORS } from "./colors.ts";
import { displayToolName, extractTextOutput, pluralize } from "./rendering.ts";
import { summarizeToolCall } from "./summaries.ts";
import { boxContentWidth, boxInner, boxRows, ICON_TOOL } from "./tool-box.ts";

/** The runtime shape of pi's ToolExecutionComponent this layout reads. Most of it is private in pi's types. */
export interface GroupMember {
	toolName: string;
	args: unknown;
	expanded: boolean;
	isPartial: boolean;
	result?: { content?: unknown; details?: unknown; isError?: boolean };
	callRendererComponent?: Component;
	resultRendererComponent?: Component;
	imageComponents?: Component[];
	toolDefinition?: Record<string, unknown>;
	setExpanded(expanded: boolean): void;
	render(width: number): string[];
}

interface ContainerLike {
	children: unknown[];
}

function isContainer(value: unknown): value is ContainerLike {
	return typeof value === "object" && value !== null && Array.isArray((value as ContainerLike).children);
}

/* -------------------------------------------------------------------------- */
/* Finding siblings                                                            */
/* -------------------------------------------------------------------------- */

const SEARCH_DEPTH = 4;
const parents = new WeakMap<object, ContainerLike>();
const positions = new WeakMap<ContainerLike, Map<unknown, number>>();
let lastParent: WeakRef<ContainerLike> | undefined;

/** Index of `child` in `parent`, rebuilding the position map only when it went stale. */
function indexIn(parent: ContainerLike, child: unknown): number {
	const cached = positions.get(parent)?.get(child);
	if (cached !== undefined && parent.children[cached] === child) return cached;
	const rebuilt = new Map<unknown, number>();
	parent.children.forEach((entry, index) => rebuilt.set(entry, index));
	positions.set(parent, rebuilt);
	return rebuilt.get(child) ?? -1;
}

/** Breadth-first, shallow: the chat container sits a level or two under the TUI root. */
function searchParent(root: unknown, child: object): ContainerLike | undefined {
	let level: ContainerLike[] = isContainer(root) ? [root] : [];
	for (let depth = 0; depth < SEARCH_DEPTH && level.length > 0; depth++) {
		const next: ContainerLike[] = [];
		for (const node of level) {
			if (node.children.includes(child)) return node;
			for (const entry of node.children) if (isContainer(entry)) next.push(entry);
		}
		level = next;
	}
	return undefined;
}

function findParent(member: GroupMember, root: unknown): ContainerLike | undefined {
	const known = parents.get(member);
	if (known && indexIn(known, member) >= 0) return known;
	const recent = lastParent?.deref();
	const parent = recent && indexIn(recent, member) >= 0 ? recent : searchParent(root, member);
	if (parent) {
		parents.set(member, parent);
		lastParent = new WeakRef(parent);
	}
	return parent;
}

function rendersNothing(component: unknown, width: number): boolean {
	const render = (component as Component | undefined)?.render;
	return typeof render === "function" && render.call(component, width).length === 0;
}

export type GroupRole = { kind: "follower" } | { kind: "leader"; members: GroupMember[] };

/**
 * The member's place in its run. Leaders and followers scan with the same
 * rule — members join, empty rows are skipped, anything else ends the run —
 * so every member agrees on who leads.
 */
export function resolveGroup(
	member: GroupMember,
	root: unknown,
	width: number,
	isMember: (component: unknown) => component is GroupMember,
): GroupRole {
	const parent = findParent(member, root);
	if (!parent) return { kind: "leader", members: [member] };
	const siblings = parent.children;
	const index = indexIn(parent, member);
	for (let i = index - 1; i >= 0; i--) {
		const sibling = siblings[i];
		if (isMember(sibling)) return { kind: "follower" };
		if (!rendersNothing(sibling, width)) break;
	}
	const members = [member];
	for (let i = index + 1; i < siblings.length; i++) {
		const sibling = siblings[i];
		if (isMember(sibling)) members.push(sibling);
		else if (!rendersNothing(sibling, width)) break;
	}
	return { kind: "leader", members };
}

/* -------------------------------------------------------------------------- */
/* Size line                                                                   */
/* -------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Raw lines, not wrapped rows: the size describes the output, not the terminal. */
export function outputSize(text: string): { lines: number; bytes: number } {
	const trimmed = text.replace(/\n+$/, "");
	if (!trimmed.trim() || trimmed.trim() === "(no output)") return { lines: 0, bytes: 0 };
	return { lines: trimmed.split("\n").length, bytes: Buffer.byteLength(trimmed, "utf8") };
}

export function sizeText({ lines, bytes }: { lines: number; bytes: number }): string {
	return lines === 0 ? "no output" : `${lines} ${pluralize(lines, "line")}, ${formatBytes(bytes)}`;
}

const metaCache = new WeakMap<GroupMember, { result: unknown; partial: boolean; text: string }>();

function memberMeta(member: GroupMember): string {
	const cached = metaCache.get(member);
	if (cached && cached.result === member.result && cached.partial === member.isPartial) return cached.text;
	let text: string;
	if (!member.result) text = "running…";
	else {
		const size = sizeText(outputSize(extractTextOutput(member.result)));
		if (member.isPartial) text = size === "no output" ? "running…" : `running · ${size}`;
		else text = member.result.isError ? `failed · ${size}` : size;
	}
	metaCache.set(member, { result: member.result, partial: member.isPartial, text });
	return text;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

interface MemberSummary {
	text: string;
	/** Argument fields the summary stands for; dropped from the expanded view when it shows them in full. */
	fields: readonly string[];
	/** The summary clipped or sketched a value, so the full arguments still have something to add. */
	partial: boolean;
}

const summaryCache = new WeakMap<GroupMember, { args: unknown; summary: MemberSummary }>();

function memberSummary(member: GroupMember): MemberSummary {
	const cached = summaryCache.get(member);
	if (cached && cached.args === member.args) return cached.summary;
	const found = summarizeToolCall(member.toolName, member.args);
	const summary: MemberSummary = found
		? { text: found.text.trim(), fields: found.fields, partial: found.hidden === true }
		: { text: (compactArguments(member.args).text.split("\n")[0] ?? "").trim(), fields: [], partial: true };
	summaryCache.set(member, { args: member.args, summary });
	return summary;
}

function memberName(member: GroupMember): string {
	const label = member.toolDefinition?.label;
	return displayToolName(member.toolName, typeof label === "string" ? label : undefined);
}

const GAP = "  ";

/** Whether the member's last drawn row showed its whole summary. */
const summaryFits = new WeakMap<GroupMember, boolean>();

function toolRow(member: GroupMember, width: number, theme: Theme): string {
	const failed = member.result?.isError === true && !member.isPartial;
	const name = memberName(member);
	const meta = memberMeta(member);
	const { name: nameTone, size: sizeTone, failed: failedTone } = TOOL_OUTPUT_COLORS.group;
	const nameColor = failed ? failedTone : nameTone;
	const metaColor = failed ? failedTone : sizeTone;
	const room = width - visibleWidth(name) - GAP.length * 2 - visibleWidth(meta);
	const summary = memberSummary(member).text;
	const shown = room >= 4 && summary ? truncateToWidth(summary, room, "…") : "";
	summaryFits.set(member, shown === summary);
	const row = [
		theme.bold(paint(theme, nameColor, name)),
		...(shown ? [theme.bold(paintSummary(shown, theme))] : []),
		paint(theme, metaColor, meta),
	].join(GAP);
	return truncateToWidth(row, width, "…");
}

/** The arguments the row's summary did not already show in full. */
function remainingArguments(member: GroupMember): unknown {
	const summary = memberSummary(member);
	const args = member.args;
	if (summary.partial || summaryFits.get(member) === false || summary.fields.length === 0) return args;
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const rest = { ...(args as Record<string, unknown>) };
	for (const field of summary.fields) delete rest[field];
	return Object.keys(rest).length > 0 ? rest : undefined;
}

const argumentsCache = new WeakMap<GroupMember, { args: unknown; shown: unknown; component: Component | undefined }>();

/** The call's own content, unframed: arguments the row did not show, then the output its renderer drew. */
function expandedComponents(member: GroupMember, theme: Theme): Component[] {
	const resultInner = boxInner(member.resultRendererComponent);
	if (boxInner(member.callRendererComponent) || resultInner) {
		const shown = remainingArguments(member);
		const cached = argumentsCache.get(member);
		const component =
			cached && cached.args === member.args && (cached.shown === undefined) === (shown === undefined)
				? cached.component
				: shown === undefined
					? undefined
					: callArgumentsComponent(member.toolName, shown, true, theme, { showSummary: false });
		argumentsCache.set(member, { args: member.args, shown, component });
		return [...(component ? [component] : []), ...(resultInner ? [resultInner] : [])];
	}
	// A builtin drawn by pi's (or another extension's) renderer: keep its rows as they are.
	return [member.callRendererComponent, member.resultRendererComponent].filter(
		(component): component is Component => component !== undefined,
	);
}

const INDENT = "  ";

function expandedRows(member: GroupMember, width: number, theme: Theme): string[] {
	const inner = Math.max(1, width - INDENT.length);
	const rows: string[] = [];
	for (const component of expandedComponents(member, theme)) {
		try {
			for (const row of component.render(inner)) rows.push(INDENT + truncateToWidth(row, inner, "…"));
		} catch {
			// A failing third-party renderer must not take the whole group down.
		}
	}
	while (rows.length > 0 && !rows[rows.length - 1]!.trim()) rows.pop();
	return rows;
}

function hintRow(member: GroupMember, expandLastKey: string, width: number, theme: Theme): string {
	const key = (text: string) => paint(theme, TOOL_OUTPUT_COLORS.group.hintKey, text);
	const words = (text: string) => paint(theme, TOOL_OUTPUT_COLORS.group.hintText, text);
	const all = keyText("app.tools.expand") || "ctrl+o";
	if (member.expanded) return truncateToWidth(`${key(expandLastKey)}${words(" to collapse")}`, width, "…");
	const full = `${key(expandLastKey)}${words(" to expand · ")}${key(all)}${words(" to expand all")}`;
	const short = `${key(expandLastKey)}${words(" expand · ")}${key(all)}${words(" all")}`;
	return truncateToWidth(visibleWidth(full) <= width ? full : short, width, "…");
}

export interface GroupRenderOptions {
	theme: Theme;
	/** The most recent tool call overall; only it carries the shortcut hint. */
	lastMember: GroupMember | undefined;
	expandLastKey: string;
}

export interface GroupRender {
	lines: string[];
	/** Which member owns each returned line, for clicks. */
	owners: (GroupMember | undefined)[];
}

export function groupLabel(members: readonly GroupMember[]): string {
	const running = members.some((member) => !member.result || member.isPartial);
	const count = `${members.length} ${pluralize(members.length, "tool")}`;
	return `${ICON_TOOL} ${running ? "Running" : "Ran"} ${count}`;
}

export function renderGroup(members: readonly GroupMember[], width: number, options: GroupRenderOptions): GroupRender {
	const { theme } = options;
	const contentWidth = boxContentWidth(width);
	const body: string[] = [];
	const bodyOwners: GroupMember[] = [];
	const images: string[] = [];
	for (const member of members) {
		const rows = [toolRow(member, contentWidth, theme)];
		if (member.expanded) {
			rows.push(...expandedRows(member, contentWidth, theme));
			for (const image of member.imageComponents ?? []) images.push(...image.render(width));
		}
		if (member === options.lastMember) rows.push(hintRow(member, options.expandLastKey, contentWidth, theme));
		body.push(...rows);
		bodyOwners.push(...rows.map(() => member));
	}
	const box = boxRows(theme, width, groupLabel(members), body, { includeTop: true, close: true });
	// Pi's own self-rendered shell leads with one blank row; keep that spacing.
	const lines = ["", ...box, ...images];
	const owners: (GroupMember | undefined)[] = [undefined, undefined, ...bodyOwners];
	while (owners.length < lines.length) owners.push(undefined);
	return { lines, owners };
}
