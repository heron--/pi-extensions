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
import { CALL_LIMITS, compactArguments } from "./arguments.ts";
import { paintArgumentLine, paintMeasure, paintSummary } from "./call-rendering.ts";
import { paint, TOOL_OUTPUT_COLORS } from "./colors.ts";
import { displayToolName, extractTextOutput, pluralize, toolIcon } from "./rendering.ts";
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

/** The argument row starts where the name does: one icon cell and a space in. */
const INDENT = "  ";
const GAP = "  ";
const DOT = " · ";

function memberHead(member: GroupMember): string {
	return `${toolIcon(member.toolName)} ${memberName(member)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * The call's input, when it carries one: its largest multi-line or long string
 * argument — a script, a file body, a prompt. It is measured on the first row
 * beside the output size instead of appearing among the arguments.
 */
function memberInput(member: GroupMember): { field: string; size: string } | undefined {
	const args = record(member.args);
	if (!args) return undefined;
	let best: { field: string; value: string } | undefined;
	for (const [field, value] of Object.entries(args)) {
		if (typeof value !== "string" || (value.length <= CALL_LIMITS.inlineChars && !/[\r\n]/.test(value))) continue;
		if (!best || value.length > best.value.length) best = { field, value };
	}
	return best && { field: best.field, size: sizeText(outputSize(best.value)) };
}

const argumentLineCache = new WeakMap<GroupMember, { args: unknown; text: string }>();

/** The arguments the summary and input did not cover, as one `key: value · …` row. */
function memberArguments(member: GroupMember): string {
	const cached = argumentLineCache.get(member);
	if (cached && cached.args === member.args) return cached.text;
	const input = memberInput(member);
	const args = record(member.args);
	const rest = args && input ? Object.fromEntries(Object.entries(args).filter(([field]) => field !== input.field)) : member.args;
	const restRecord = record(rest);
	const text =
		restRecord && Object.keys(restRecord).length === 0
			? ""
			: compactArguments(rest, memberSummary(member).fields).text.replace(/^\(no arguments\)$/, "");
	argumentLineCache.set(member, { args: member.args, text });
	return text;
}

/**
 * One call, up to two rows:
 *
 *   icon name  summary  [input size · ]output size
 *   key: value · key: value      (arguments the summary does not show)
 *
 * `nameWidth` pads every name in the group to one width so the summaries form
 * a column. The summary yields width first; the sizes are kept whole.
 */
function toolRows(member: GroupMember, width: number, nameWidth: number, theme: Theme): string[] {
	const failed = member.result?.isError === true && !member.isPartial;
	const { name: nameTone, size: sizeTone, failed: failedTone, summaryPlain, summaryKey } = TOOL_OUTPUT_COLORS.group;
	const head = memberHead(member);
	const padded = head + " ".repeat(Math.max(0, nameWidth - visibleWidth(head)));
	const input = memberInput(member);
	const meta = memberMeta(member);
	const sizes =
		(input ? `${paintMeasure(input.size, theme)}${paint(theme, sizeTone, DOT)}` : "") +
		paint(theme, failed ? failedTone : sizeTone, meta);
	const sizesWidth = (input ? visibleWidth(input.size) + DOT.length : 0) + visibleWidth(meta);
	const room = width - visibleWidth(padded) - GAP.length * 2 - sizesWidth;
	const summary = memberSummary(member).text;
	const shown = room >= 4 && summary ? truncateToWidth(summary, room, "…") : "";
	const colors = { plain: summaryPlain, key: summaryKey, value: TOOL_OUTPUT_COLORS.call.summaryValue };
	const first = [
		theme.bold(paint(theme, failed ? failedTone : nameTone, padded)),
		...(shown ? [paintSummary(shown, theme, colors)] : []),
		sizes,
	].join(GAP);
	const rows = [truncateToWidth(first, width, "…")];
	const rest = memberArguments(member);
	if (rest) rows.push(INDENT + truncateToWidth(paintArgumentLine(rest, theme), Math.max(1, width - INDENT.length), "…"));
	return rows;
}

/** The call's output, unframed: what its own result renderer drew, without its arguments. */
function expandedComponents(member: GroupMember): Component[] {
	const result = boxInner(member.resultRendererComponent) ?? member.resultRendererComponent;
	return result ? [result] : [];
}

function expandedRows(member: GroupMember, width: number, theme: Theme): string[] {
	const inner = Math.max(1, width - INDENT.length);
	const rows: string[] = [];
	for (const component of expandedComponents(member)) {
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
	// Summaries line up in one column, unless the longest name would crowd them out.
	const longest = Math.max(...members.map((member) => visibleWidth(memberHead(member))));
	const nameWidth = Math.min(longest, Math.max(0, Math.floor(contentWidth / 3)));
	for (const member of members) {
		const rows = toolRows(member, contentWidth, nameWidth, theme);
		if (member.expanded) {
			rows.push(...expandedRows(member, contentWidth, theme));
			for (const image of member.imageComponents ?? []) images.push(...image.render(width));
		}
		if (member === options.lastMember) {
			rows.push(INDENT + hintRow(member, options.expandLastKey, Math.max(1, contentWidth - INDENT.length), theme));
		}
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
