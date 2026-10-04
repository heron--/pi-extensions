import assert from "node:assert/strict";
import test from "node:test";
import { PR_MISS_TTL_MS, PullRequestTracker } from "./pull-request.ts";

/** A runner that records lookups and lets the test answer them. */
function fakeRunner() {
	const calls = [];
	const run = (cwd, branch, done) => calls.push({ cwd, branch, done });
	return { calls, run };
}

function watcher(cwd, branch) {
	const state = { branch, resolved: 0 };
	return { state, cwd, currentBranch: () => state.branch, onResolved: () => state.resolved++ };
}

test("no lookup runs until a footer watches", () => {
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run);
	tracker.sync();
	assert.equal(runner.calls.length, 0);
	tracker.watch(watcher("/repo", "main"));
	assert.equal(runner.calls.length, 1);
	tracker.watch(null);
});

test("a found pull request is cached by repository and branch", () => {
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run);
	const footer = watcher("/repo", "feature");
	tracker.watch(footer);
	runner.calls[0].done({ number: 7, url: "https://example.com/pull/7" });
	assert.equal(footer.state.resolved, 1);
	assert.deepEqual(tracker.get("/repo", "feature"), { number: 7, url: "https://example.com/pull/7" });
	assert.equal(tracker.get("/other", "feature"), null);
	tracker.sync();
	assert.equal(runner.calls.length, 1);
	tracker.watch(null);
});

test("an in-flight lookup is not repeated", () => {
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run);
	tracker.watch(watcher("/repo", "feature"));
	tracker.watch(watcher("/repo", "feature"));
	tracker.sync();
	assert.equal(runner.calls.length, 1);
	tracker.watch(null);
});

test("a result for another branch or a stopped footer is cached but not announced", () => {
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run);
	const footer = watcher("/repo", "first");
	tracker.watch(footer);
	footer.state.branch = "second";
	tracker.sync();
	runner.calls[0].done({ number: 1, url: "https://example.com/pull/1" });
	assert.equal(footer.state.resolved, 0);
	assert.equal(tracker.get("/repo", "first").number, 1);

	tracker.watch(null);
	runner.calls[1].done({ number: 2, url: "https://example.com/pull/2" });
	assert.equal(footer.state.resolved, 0);
});

test("a miss is rechecked once its window expires, and stopping cancels the recheck", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run, () => Date.now());
	const footer = watcher("/repo", "feature");
	tracker.watch(footer);
	runner.calls[0].done(null);
	t.mock.timers.tick(PR_MISS_TTL_MS - 1);
	assert.equal(runner.calls.length, 1);
	t.mock.timers.tick(1);
	assert.equal(runner.calls.length, 2);

	runner.calls[1].done(null);
	tracker.watch(null);
	t.mock.timers.tick(PR_MISS_TTL_MS * 2);
	assert.equal(runner.calls.length, 2);
});

test("a cached miss still in its window re-arms the recheck instead of looking up", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const runner = fakeRunner();
	const tracker = new PullRequestTracker(runner.run, () => Date.now());
	tracker.watch(watcher("/repo", "feature"));
	runner.calls[0].done(null);
	t.mock.timers.tick(10_000);
	// A rebuilt footer inside the window: no new lookup, but the recheck stays armed.
	tracker.watch(watcher("/repo", "feature"));
	assert.equal(runner.calls.length, 1);
	t.mock.timers.tick(PR_MISS_TTL_MS - 10_000);
	assert.equal(runner.calls.length, 2);
	tracker.watch(null);
});
