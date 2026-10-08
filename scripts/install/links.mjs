/**
 * The symlinks that install extensions into pi's extension directory.
 *
 * The links are the only record of what is installed: an extension is
 * installed when `<extensions dir>/<name>` is a symlink that resolves to this
 * checkout's `<name>` directory. Planning compares that state with the
 * selection, so an unchanged selection plans nothing.
 *
 * `lib/` is linked beside the extensions whenever any are selected: their
 * relative imports (`../lib/box.ts`) resolve against the link's path, not the
 * checkout's.
 *
 * Real files and directories are never touched, and only symlinks that point
 * into this checkout are removed.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const LIB = "lib";

/**
 * What is at `linkPath`, compared with the link to `targetPath` that should be:
 * `missing`, `ok`, `dangling` (a link to nothing), `elsewhere` (a link to
 * something else) or `occupied` (a real file or directory).
 */
export function inspectLink(linkPath, targetPath) {
	let stats;
	try {
		stats = lstatSync(linkPath);
	} catch {
		return { state: "missing" };
	}
	if (!stats.isSymbolicLink()) return { state: "occupied", kind: stats.isDirectory() ? "directory" : "file" };
	const current = readlinkSync(linkPath);
	let resolved;
	try {
		resolved = realpathSync(linkPath);
	} catch {
		return { state: "dangling", current };
	}
	return resolved === realpathSync(targetPath) ? { state: "ok" } : { state: "elsewhere", current, resolved };
}

/** Whether the link at `linkPath`, reading `current`, names a path inside `root`. */
function pointsInto(linkPath, current, root) {
	return resolve(dirname(linkPath), current).startsWith(root + sep);
}

/**
 * The changes that make `extensionsDir` match `selected`, grouped by how much
 * consent they need:
 *
 * - `create`, and `repair` (replace a link to nothing in this checkout),
 *   apply without asking.
 * - `replace` swaps a link that points somewhere else, such as another
 *   checkout, even to nothing; it needs confirmation.
 * - `remove` deletes this checkout's links that are no longer wanted: those
 *   of deselected extensions, `lib` when nothing is selected, and broken
 *   links into this checkout, such as one left by a renamed extension. It
 *   needs confirmation.
 * - `blocked` lists selected names whose place a real file or directory holds.
 */
export function planLinks({ repoRoot, extensionsDir, names, selected, hasLib }) {
	const plan = { create: [], repair: [], replace: [], remove: [], blocked: [] };
	const wanted = new Map(names.map((name) => [name, selected.has(name)]));
	if (hasLib) wanted.set(LIB, selected.size > 0);

	for (const [name, isWanted] of wanted) {
		const linkPath = join(extensionsDir, name);
		const target = join(repoRoot, name);
		const link = inspectLink(linkPath, target);
		const change = { name, linkPath, target, current: link.current };
		if (isWanted) {
			if (link.state === "missing") plan.create.push(change);
			else if (link.state === "dangling" && pointsInto(linkPath, link.current, repoRoot)) plan.repair.push(change);
			else if (link.state === "dangling" || link.state === "elsewhere") plan.replace.push(change);
			else if (link.state === "occupied") plan.blocked.push({ ...change, kind: link.kind });
		} else if (link.state === "ok") {
			plan.remove.push({ ...change, reason: name === LIB ? "unused" : "deselected" });
		} else if (link.state === "dangling" && pointsInto(linkPath, link.current, repoRoot)) {
			plan.remove.push({ ...change, reason: "broken" });
		}
	}

	for (const entry of safeReaddir(extensionsDir)) {
		if (wanted.has(entry)) continue;
		const linkPath = join(extensionsDir, entry);
		const current = danglingTarget(linkPath);
		if (current !== undefined && pointsInto(linkPath, current, repoRoot)) {
			plan.remove.push({ name: entry, linkPath, current, reason: "broken" });
		}
	}
	return plan;
}

/** What a link to nothing at `linkPath` reads, or undefined for anything else. */
function danglingTarget(linkPath) {
	try {
		const current = readlinkSync(linkPath);
		return existsSync(linkPath) ? undefined : current;
	} catch {
		return undefined;
	}
}

function safeReaddir(path) {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

export function createLink(change) {
	mkdirSync(dirname(change.linkPath), { recursive: true });
	symlinkSync(change.target, change.linkPath);
}

/** Replace a symlink with one to `change.target`. */
export function relink(change) {
	unlinkSymlink(change.linkPath);
	symlinkSync(change.target, change.linkPath);
}

/** Delete a symlink, refusing anything that is not one. */
export function unlinkSymlink(linkPath) {
	if (!lstatSync(linkPath).isSymbolicLink()) throw new Error(`${linkPath} is not a symlink`);
	unlinkSync(linkPath);
}
