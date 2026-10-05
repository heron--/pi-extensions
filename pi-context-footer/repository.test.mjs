import assert from "node:assert/strict";
import test from "node:test";
import { parseRepository, RepositoryTracker } from "./repository.ts";

test("a repository is named for its shared Git directory", () => {
	assert.deepEqual(parseRepository("/src/pi-extensions", ".git\n\n"), { name: "pi-extensions", subdir: "" });
	assert.deepEqual(
		parseRepository("/src/pi-extensions/pi-context-footer", "/src/pi-extensions/.git\npi-context-footer/\n"),
		{ name: "pi-extensions", subdir: "pi-context-footer" },
	);
	assert.deepEqual(parseRepository("/src/a/b", "../../.git\nb/c/\n"), { name: "src", subdir: "b/c" }, "relative to cwd");
	// A linked worktree reports the main repository's common directory.
	assert.deepEqual(
		parseRepository("/wt/feature--1234/lib", "/src/pi-extensions/.git\nlib/\n"),
		{ name: "pi-extensions", subdir: "lib" },
	);
	assert.deepEqual(parseRepository("/srv/dotfiles.git", ".\n\n"), { name: "dotfiles", subdir: "" }, "a bare repository drops .git");
	assert.equal(parseRepository("/src", ""), null);
});

test("lookups are cached per directory, and only a found repository repaints", () => {
	const calls = [];
	const tracker = new RepositoryTracker((cwd, done) => calls.push({ cwd, done }));
	let repaints = 0;
	const repaint = () => repaints++;

	tracker.lookup("/repo", repaint);
	tracker.lookup("/repo", repaint);
	assert.equal(calls.length, 1, "an in-flight lookup is not repeated");
	assert.equal(tracker.get("/repo"), null, "unknown until git answers");
	calls[0].done({ name: "repo", subdir: "" });
	assert.equal(repaints, 1);
	assert.deepEqual(tracker.get("/repo"), { name: "repo", subdir: "" });
	tracker.lookup("/repo", repaint);
	assert.equal(calls.length, 1, "a found repository is kept");

	tracker.lookup("/tmp", repaint);
	calls[1].done(null);
	assert.equal(repaints, 1, "a miss repaints nothing");
	tracker.lookup("/tmp", repaint);
	assert.equal(calls.length, 2, "a miss is kept too");
});
