/**
 * The pull-request item's data: `gh pr view` for the current branch, run in
 * the background so a render never waits for it.
 *
 * Lookups run only while a footer is watching — the footer is enabled and its
 * layout selects the item. Whether the item survives the width does not
 * matter: a clipped item is still selected, and its data is still wanted.
 */

import { execFile } from "node:child_process";

export interface PullRequest {
	number: number;
	url: string;
}

/** Look up the pull request for `branch` in `cwd`, calling `done` once. */
export type PullRequestRunner = (cwd: string, branch: string, done: (pullRequest: PullRequest | null) => void) => void;

const PR_LOOKUP_TIMEOUT_MS = 5_000;
/** How long "no pull request" is trusted before `gh` is asked again. */
export const PR_MISS_TTL_MS = 60_000;

export const ghPullRequest: PullRequestRunner = (cwd, branch, done) => {
	execFile("gh", ["pr", "view", branch, "--json", "number,url"], { cwd, timeout: PR_LOOKUP_TIMEOUT_MS }, (error, stdout) => {
		if (error) return done(null);
		try {
			const parsed = JSON.parse(stdout) as { number?: unknown; url?: unknown };
			if (typeof parsed.number === "number" && typeof parsed.url === "string") {
				return done({ number: parsed.number, url: parsed.url });
			}
		} catch {
			// `gh` printed something else.
		}
		done(null);
	});
};

/** What a footer watching for pull requests supplies. */
export interface PullRequestWatcher {
	/** The repository the lookups run in. */
	cwd: string;
	currentBranch(): string | null;
	/** A pull request was found for the current branch; repaint. */
	onResolved(): void;
}

interface Lookup {
	pullRequest: PullRequest | null;
	/** When `gh` answered, for expiring misses. */
	at: number;
}

function cacheKey(cwd: string, branch: string): string {
	return `${cwd}\0${branch}`;
}

/**
 * A found pull request is kept for the tracker's life. A miss is kept for
 * PR_MISS_TTL_MS and then rechecked on a timer while a footer is watching, so
 * a branch without a PR spawns `gh` at most once per window and a PR opened
 * mid-session appears without waiting for a repaint.
 *
 * Results are cached by repository and branch, and a result only reaches the
 * footer watching that same repository and branch when it arrives; one that
 * outlived its footer, branch or session is cached and otherwise ignored.
 */
export class PullRequestTracker {
	private readonly cache = new Map<string, Lookup>();
	private readonly inFlight = new Set<string>();
	private watcher: PullRequestWatcher | null = null;
	private recheck: ReturnType<typeof setTimeout> | undefined;
	private readonly run: PullRequestRunner;
	private readonly now: () => number;

	constructor(run: PullRequestRunner = ghPullRequest, now: () => number = Date.now) {
		this.run = run;
		this.now = now;
	}

	/** The cached pull request for a repository and branch, if one was found. */
	get(cwd: string, branch: string): PullRequest | null {
		return this.cache.get(cacheKey(cwd, branch))?.pullRequest ?? null;
	}

	/** Start watching for `watcher`, or stop all lookups and timers with null. */
	watch(watcher: PullRequestWatcher | null): void {
		this.watcher = watcher;
		this.cancelRecheck();
		this.sync();
	}

	/** Look up the watched branch if nothing is cached, in flight or still trusted. */
	sync(): void {
		const watcher = this.watcher;
		const branch = watcher?.currentBranch();
		if (!watcher || !branch) return;
		const key = cacheKey(watcher.cwd, branch);
		if (this.inFlight.has(key)) return;
		const cached = this.cache.get(key);
		if (cached?.pullRequest) return;
		if (cached) {
			const remaining = PR_MISS_TTL_MS - (this.now() - cached.at);
			if (remaining > 0) {
				this.scheduleRecheck(remaining);
				return;
			}
		}

		this.inFlight.add(key);
		const { cwd } = watcher;
		this.run(cwd, branch, (pullRequest) => {
			this.inFlight.delete(key);
			this.cache.set(key, { pullRequest, at: this.now() });
			const current = this.watcher;
			if (!current || current.cwd !== cwd || current.currentBranch() !== branch) return;
			if (pullRequest) current.onResolved();
			else this.scheduleRecheck(PR_MISS_TTL_MS);
		});
	}

	private scheduleRecheck(delayMs: number): void {
		this.cancelRecheck();
		this.recheck = setTimeout(() => {
			this.recheck = undefined;
			this.sync();
		}, Math.max(0, delayMs));
		// A pending recheck must not hold pi open at quit.
		this.recheck.unref?.();
	}

	private cancelRecheck(): void {
		clearTimeout(this.recheck);
		this.recheck = undefined;
	}
}
