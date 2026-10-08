import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLink, inspectLink, planLinks, relink, unlinkSymlink } from "./links.mjs";

/** A checkout with two extensions and lib, a second checkout, and an empty extension directory. */
function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-links-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repoRoot = join(root, "checkout");
	const otherRoot = join(root, "other-checkout");
	for (const dir of ["pi-a", "pi-b", "lib"]) {
		mkdirSync(join(repoRoot, dir), { recursive: true });
		mkdirSync(join(otherRoot, dir), { recursive: true });
	}
	const extensionsDir = join(root, "agent", "extensions");
	const plan = (...selected) =>
		planLinks({ repoRoot, extensionsDir, names: ["pi-a", "pi-b"], selected: new Set(selected), hasLib: true });
	return { root, repoRoot, otherRoot, extensionsDir, plan };
}

const names = (changes) => changes.map((change) => change.name);

function apply(plan) {
	for (const change of plan.remove) unlinkSymlink(change.linkPath);
	for (const change of [...plan.repair, ...plan.replace]) relink(change);
	for (const change of plan.create) createLink(change);
}

test("a first run links the selection and lib; running it again plans nothing", (t) => {
	const { repoRoot, extensionsDir, plan } = fixture(t);
	const first = plan("pi-a");
	assert.deepEqual(names(first.create), ["pi-a", "lib"]);
	apply(first);
	assert.equal(readlinkSync(join(extensionsDir, "pi-a")), join(repoRoot, "pi-a"));
	assert.equal(inspectLink(join(extensionsDir, "lib"), join(repoRoot, "lib")).state, "ok");
	assert.deepEqual(plan("pi-a"), { create: [], repair: [], replace: [], remove: [], blocked: [] });
});

test("deselecting offers this checkout's links for removal, and lib with the last one", (t) => {
	const { extensionsDir, plan } = fixture(t);
	apply(plan("pi-a", "pi-b"));
	const some = plan("pi-b");
	assert.deepEqual(some.remove.map(({ name, reason }) => [name, reason]), [["pi-a", "deselected"]]);
	const none = plan();
	assert.deepEqual(none.remove.map(({ name, reason }) => [name, reason]), [
		["pi-a", "deselected"],
		["pi-b", "deselected"],
		["lib", "unused"],
	]);
	apply(none);
	assert.equal(inspectLink(join(extensionsDir, "pi-a"), extensionsDir).state, "missing");
	assert.deepEqual(plan(), { create: [], repair: [], replace: [], remove: [], blocked: [] });
});

test("a link to nothing is repaired; one to another checkout needs consent", (t) => {
	const { repoRoot, otherRoot, extensionsDir, plan } = fixture(t);
	mkdirSync(extensionsDir, { recursive: true });
	symlinkSync(join(repoRoot, "pi-gone"), join(extensionsDir, "pi-a"));
	symlinkSync(join(otherRoot, "pi-b"), join(extensionsDir, "pi-b"));
	const both = plan("pi-a", "pi-b");
	assert.deepEqual(names(both.repair), ["pi-a"]);
	assert.deepEqual(both.replace.map(({ name, current }) => [name, current]), [["pi-b", join(otherRoot, "pi-b")]]);
	apply(both);
	assert.equal(inspectLink(join(extensionsDir, "pi-b"), join(repoRoot, "pi-b")).state, "ok");
});

test("links this checkout does not own are never offered for removal", (t) => {
	const { root, otherRoot, extensionsDir, plan } = fixture(t);
	mkdirSync(extensionsDir, { recursive: true });
	symlinkSync(join(otherRoot, "pi-a"), join(extensionsDir, "pi-a"));
	symlinkSync(join(root, "elsewhere", "missing"), join(extensionsDir, "pi-foreign"));
	assert.deepEqual(plan().remove, []);
});

test("broken links into this checkout are offered for removal under any name", (t) => {
	const { repoRoot, extensionsDir, plan } = fixture(t);
	mkdirSync(extensionsDir, { recursive: true });
	symlinkSync(join(repoRoot, "pi-renamed"), join(extensionsDir, "pi-renamed"));
	symlinkSync(join(repoRoot, "pi-moved"), join(extensionsDir, "pi-b"));
	assert.deepEqual(
		plan("pi-a").remove.map(({ name, reason }) => [name, reason]),
		[["pi-b", "broken"], ["pi-renamed", "broken"]],
	);
});

test("a real file or directory in the way is reported and never touched", (t) => {
	const { extensionsDir, plan } = fixture(t);
	mkdirSync(join(extensionsDir, "pi-a"), { recursive: true });
	writeFileSync(join(extensionsDir, "lib"), "");
	const blocked = plan("pi-a").blocked;
	assert.deepEqual(blocked.map(({ name, kind }) => [name, kind]), [["pi-a", "directory"], ["lib", "file"]]);
	assert.deepEqual(plan().remove, []);
	assert.throws(() => unlinkSymlink(join(extensionsDir, "pi-a")), /not a symlink/);
	assert.ok(lstatSync(join(extensionsDir, "pi-a")).isDirectory());
});
