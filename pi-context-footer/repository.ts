/**
 * The directory item's repository: which Git repository the session's working
 * directory sits in, and where below its root. `git` runs in the background
 * once per working directory, so a render never waits for it; until it
 * answers, the directory item shows the plain directory name.
 */

import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export interface Repository {
	/** The repository's name, from its shared Git directory. */
	name: string;
	/** The path below the repository root, without a trailing slash; empty at the root. */
	subdir: string;
}

/** Look up the repository containing `cwd`, calling `done` once. */
export type RepositoryRunner = (cwd: string, done: (repository: Repository | null) => void) => void;

const REPO_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Parse `git rev-parse --git-common-dir --show-prefix` run in `cwd`. The
 * common directory is shared by every worktree, so a linked worktree is named
 * for the repository it belongs to rather than for its own directory. A
 * common directory named `.git` takes its parent's name; any other (a bare
 * repository) drops a trailing `.git`.
 */
export function parseRepository(cwd: string, stdout: string): Repository | null {
	const [commonLine, prefixLine = ""] = stdout.split("\n");
	if (!commonLine) return null;
	const common = resolve(cwd, commonLine);
	const name = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
	if (!name) return null;
	return { name, subdir: prefixLine.replace(/\/+$/, "") };
}

export const gitRepository: RepositoryRunner = (cwd, done) => {
	execFile("git", ["rev-parse", "--git-common-dir", "--show-prefix"], { cwd, timeout: REPO_LOOKUP_TIMEOUT_MS }, (error, stdout) => {
		done(error ? null : parseRepository(cwd, stdout));
	});
};

/**
 * Repository lookups cached per working directory for the tracker's life.
 * `lookup` starts one for a directory not yet asked about and calls
 * `onResolved` when it finds a repository; outside one there is nothing new
 * to draw, so a miss repaints nothing.
 */
export class RepositoryTracker {
	private readonly cache = new Map<string, Repository | null>();
	private readonly inFlight = new Set<string>();
	private readonly run: RepositoryRunner;

	constructor(run: RepositoryRunner = gitRepository) {
		this.run = run;
	}

	/** The cached repository for `cwd`: null outside one, or while unknown. */
	get(cwd: string): Repository | null {
		return this.cache.get(cwd) ?? null;
	}

	lookup(cwd: string, onResolved: () => void): void {
		if (this.cache.has(cwd) || this.inFlight.has(cwd)) return;
		this.inFlight.add(cwd);
		this.run(cwd, (repository) => {
			this.inFlight.delete(cwd);
			this.cache.set(cwd, repository);
			if (repository) onResolved();
		});
	}
}
