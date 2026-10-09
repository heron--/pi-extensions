/**
 * What an edit or write changes, as a diff for the diff view.
 *
 * Once the call has run, the change comes from its result: pi's edit tool
 * records its diff, and this extension's write records what the write
 * replaced (`WriteDetails`), so a reloaded session shows the same change.
 * While the call is pending, it is previewed from its arguments against the
 * file as it is now. Previews read only files inside the working directory,
 * and only files up to `MAX_READ_BYTES`.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateDiffString } from "@earendil-works/pi-coding-agent";

/** Files larger than this are not read, for a preview or for a write's diff. */
export const MAX_READ_BYTES = 1_000_000;
/** Beyond this many lines on either side, a write's diff is not worked out. */
const MAX_DIFF_LINES = 20_000;

export interface FileChange {
	/** The state shown above the change: `pending edit`, `new file`. */
	label?: string;
	/** pi's display diff of the change. */
	diff?: string;
	/** Why there is no diff to show. */
	notice?: string;
}

/**
 * What this extension's write records in its result. `diff` is pi's display
 * diff of the old contents against the new; a new file records none, since
 * its contents are the call's own arguments.
 */
export interface WriteDetails {
	created: boolean;
	diff?: string;
	/** Why an overwrite has no diff. */
	diffOmitted?: string;
}

interface EditBlock {
	oldText: string;
	newText: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/* -------------------------------------------------------------------------- */
/* Paths and reads                                                             */
/* -------------------------------------------------------------------------- */

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** A tool's path argument, resolved the way pi's file tools resolve it. */
export function resolveToolPath(path: string, cwd: string): string {
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

type FileRead = { exists: false } | { exists: true; content: string } | { exists: boolean; error: string };

/** Read a file as text, if it is a regular file small enough to diff. */
function readText(path: string): FileRead {
	let size: number;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return { exists: true, error: "it is not a regular file" };
		size = stats.size;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { exists: false }
			: { exists: false, error: `it could not be read (${(error as Error).message})` };
	}
	if (size > MAX_READ_BYTES) return { exists: true, error: `it is larger than ${MAX_READ_BYTES / 1_000_000} MB` };
	try {
		return { exists: true, content: readFileSync(path, "utf8") };
	} catch (error) {
		return { exists: true, error: `it could not be read (${(error as Error).message})` };
	}
}

function within(root: string, path: string): boolean {
	const offset = relative(root, path);
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Read a file for a preview: only inside the working directory, before and after following links. */
function readForPreview(path: string, cwd: string): FileRead {
	const root = realpathOr(resolve(cwd));
	const target = resolveToolPath(path, cwd);
	if (!within(root, target) || !within(root, realpathOr(target))) {
		return { exists: false, error: "it is outside the working directory" };
	}
	return readText(target);
}

/* -------------------------------------------------------------------------- */
/* Edits                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The replacements an edit asks for, read as pi's edit tool reads them: an
 * `edits` array (or one edit, or the array as a JSON string), or a single
 * top-level `oldText`/`newText`.
 */
export function editBlocks(args: unknown): EditBlock[] | undefined {
	const fields = record(args);
	if (!fields) return undefined;
	let edits = fields.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			return undefined;
		}
	}
	if (record(edits)) edits = [edits];
	const blocks = Array.isArray(edits) ? edits : typeof fields.oldText === "string" ? [fields] : undefined;
	if (!blocks || blocks.length === 0) return undefined;
	const valid = blocks.every((block) => typeof record(block)?.oldText === "string" && typeof record(block)?.newText === "string");
	return valid ? (blocks as EditBlock[]) : undefined;
}

function toLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * Apply `blocks` to `content` with the rules pi's edit tool enforces: each
 * `oldText` matches exactly one place, and no two overlap. The result is in
 * LF line endings, as pi's own diff is.
 */
export function projectEdits(content: string, blocks: readonly EditBlock[]): { before: string; after: string } | { reason: string } {
	const before = toLF(content.replace(/^\uFEFF/, ""));
	const ranges: { start: number; end: number; text: string }[] = [];
	for (const [index, block] of blocks.entries()) {
		const oldText = toLF(block.oldText);
		const which = blocks.length > 1 ? `edit ${index + 1}` : "the edit";
		if (!oldText) return { reason: `${which} has no text to replace` };
		const start = before.indexOf(oldText);
		if (start < 0) return { reason: `${which} does not match the file as it is now` };
		if (before.indexOf(oldText, start + 1) >= 0) return { reason: `${which} matches more than one place` };
		ranges.push({ start, end: start + oldText.length, text: toLF(block.newText) });
	}
	ranges.sort((a, b) => a.start - b.start);
	let after = "";
	let cursor = 0;
	for (const range of ranges) {
		if (range.start < cursor) return { reason: "two edits overlap" };
		after += before.slice(cursor, range.start) + range.text;
		cursor = range.end;
	}
	return { before, after: after + before.slice(cursor) };
}

/** A pending edit, previewed against the file as it is now. */
export function pendingEditChange(args: unknown, cwd: string): FileChange {
	const label = "pending edit";
	const path = typeof record(args)?.path === "string" ? (record(args)!.path as string) : undefined;
	const blocks = editBlocks(args);
	if (!path || !blocks) return { label, notice: "Preview not shown: the edit has no replacements yet." };
	const read = readForPreview(path, cwd);
	if ("error" in read) return { label, notice: `Preview not shown: ${read.error}.` };
	if (!read.exists) return { label, notice: "Preview not shown: the file does not exist." };
	const projected = projectEdits(read.content, blocks);
	if ("reason" in projected) return { label, notice: `Preview not shown: ${projected.reason}.` };
	const { diff } = generateDiffString(projected.before, projected.after);
	return diff ? { label, diff } : { label, notice: "The edit changes nothing." };
}

/** A finished edit: the diff pi's edit tool recorded. */
export function editResultChange(details: unknown): FileChange | undefined {
	const diff = record(details)?.diff;
	return typeof diff === "string" ? (diff ? { diff } : { notice: "The edit changed nothing." }) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

function lineCount(text: string): number {
	return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

/** pi's display diff from `before` to `after`, or why it was not worked out. */
function writeDiff(before: string, after: string): { diff: string } | { omitted: string } {
	if (lineCount(before) > MAX_DIFF_LINES || lineCount(after) > MAX_DIFF_LINES) {
		return { omitted: `the file has more than ${MAX_DIFF_LINES.toLocaleString("en-US")} lines` };
	}
	return { diff: generateDiffString(toLF(before), toLF(after)).diff };
}

/** What a file holds before a write replaces it, for the write's details. */
export function readBeforeWrite(path: string, cwd: string): FileRead {
	return readText(resolveToolPath(path, cwd));
}

/** The details this extension's write records, from the file before it and the content written. */
export function writeDetails(before: FileRead, content: string): WriteDetails {
	if (!before.exists && !("error" in before)) return { created: true };
	if ("error" in before) return { created: false, diffOmitted: `the file was not read because ${before.error}` };
	const result = writeDiff(before.content, content);
	return "diff" in result ? { created: false, diff: result.diff } : { created: false, diffOmitted: result.omitted };
}

function writeContent(args: unknown): string | undefined {
	const content = record(args)?.content;
	return typeof content === "string" ? content : undefined;
}

/** A pending write, previewed against the file as it is now. */
export function pendingWriteChange(args: unknown, cwd: string): FileChange {
	const path = typeof record(args)?.path === "string" ? (record(args)!.path as string) : undefined;
	const content = writeContent(args);
	if (!path || content === undefined) return { label: "pending write", notice: "Preview not shown: the write has no content yet." };
	const read = readForPreview(path, cwd);
	if ("error" in read) return { label: "pending write", notice: `Preview not shown: ${read.error}.` };
	if (!read.exists) return { label: "pending create", diff: generateDiffString("", toLF(content)).diff };
	const result = writeDiff(read.content, content);
	if ("omitted" in result) return { label: "pending overwrite", notice: `Preview not shown: ${result.omitted}.` };
	return result.diff
		? { label: "pending overwrite", diff: result.diff }
		: { label: "pending overwrite", notice: "The write changes nothing." };
}

function isWriteDetails(value: unknown): value is WriteDetails {
	return typeof record(value)?.created === "boolean";
}

/**
 * A finished write, from the details this extension's write recorded.
 * Undefined for a write that recorded none, such as pi's own.
 */
export function writeResultChange(args: unknown, details: unknown): FileChange | undefined {
	if (!isWriteDetails(details)) return undefined;
	if (details.created) {
		const content = writeContent(args);
		return content === undefined ? { label: "new file" } : { label: "new file", diff: generateDiffString("", toLF(content)).diff };
	}
	if (typeof details.diff === "string") return details.diff ? { diff: details.diff } : { notice: "The write changed nothing." };
	return { notice: `The change is not shown: ${details.diffOmitted ?? "the previous contents were not recorded"}.` };
}

/** The lines a finished write added and removed, from its details. */
export function writeChanges(args: unknown, details: unknown): { added: number; removed: number } | undefined {
	if (!isWriteDetails(details)) return undefined;
	if (details.created) return { added: lineCount(writeContent(args) ?? ""), removed: 0 };
	if (typeof details.diff !== "string") return undefined;
	let added = 0;
	let removed = 0;
	for (const line of details.diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
