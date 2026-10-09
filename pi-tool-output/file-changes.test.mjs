import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	editBlocks,
	editResultChange,
	pendingEditChange,
	pendingWriteChange,
	projectEdits,
	readBeforeWrite,
	resolveToolPath,
	writeChanges,
	writeDetails,
	writeResultChange,
} from "./file-changes.ts";

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-output-changes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "a.ts"), "one\ntwo\nthree\n");
	writeFileSync(join(root, "secret.ts"), "secret\n");
	return { root, cwd };
}

test("resolveToolPath reads a path the way pi's file tools do", () => {
	assert.equal(resolveToolPath("src/a.ts", "/work"), "/work/src/a.ts");
	assert.equal(resolveToolPath("@src/a.ts", "/work"), "/work/src/a.ts");
	assert.equal(resolveToolPath("/abs/a.ts", "/work"), "/abs/a.ts");
	assert.equal(resolveToolPath("~/a.ts", "/work"), join(homedir(), "a.ts"));
	assert.equal(resolveToolPath("my\u00a0file.ts", "/work"), "/work/my file.ts");
});

test("editBlocks accepts every shape pi's edit tool accepts", () => {
	const block = { oldText: "a", newText: "b" };
	assert.deepEqual(editBlocks({ edits: [block] }), [block]);
	assert.deepEqual(editBlocks({ edits: JSON.stringify([block]) }), [block]);
	assert.deepEqual(editBlocks({ edits: block }), [block]);
	assert.deepEqual(editBlocks({ path: "x", ...block }), [{ path: "x", ...block }]);
	assert.equal(editBlocks({ edits: [{ oldText: "a" }] }), undefined, "an edit still streaming");
	assert.equal(editBlocks({ edits: [] }), undefined);
	assert.equal(editBlocks({ edits: "[{" }), undefined);
});

test("projectEdits applies pi's matching rules", () => {
	assert.deepEqual(projectEdits("\uFEFFa\r\nb\r\nc\r\n", [{ oldText: "b", newText: "B" }]), { before: "a\nb\nc\n", after: "a\nB\nc\n" });
	assert.deepEqual(
		projectEdits("one two three", [{ oldText: "three", newText: "3" }, { oldText: "one", newText: "1" }]),
		{ before: "one two three", after: "1 two 3" },
		"edits apply to the original file in any order",
	);
	assert.deepEqual(projectEdits("aaa", [{ oldText: "a", newText: "b" }]), { reason: "the edit matches more than one place" });
	assert.deepEqual(projectEdits("abc", [{ oldText: "x", newText: "y" }]), { reason: "the edit does not match the file as it is now" });
	assert.deepEqual(projectEdits("abc", [{ oldText: "", newText: "y" }]), { reason: "the edit has no text to replace" });
	assert.deepEqual(
		projectEdits("abcdef", [{ oldText: "abc", newText: "1" }, { oldText: "cde", newText: "2" }]),
		{ reason: "two edits overlap" },
	);
	assert.deepEqual(projectEdits("a b", [{ oldText: "a", newText: "x" }, { oldText: "z", newText: "y" }]), { reason: "edit 2 does not match the file as it is now" });
});

test("a pending edit previews against the file, and only inside the working directory", (t) => {
	const { root, cwd } = workspace(t);
	const preview = pendingEditChange({ path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] }, cwd);
	assert.equal(preview.label, "pending edit");
	assert.match(preview.diff, /^-2 two\n\+2 TWO$/m);
	assert.match(pendingEditChange({ path: "a.ts", edits: [{ oldText: "two", newText: "two" }] }, cwd).notice, /changes nothing/);
	assert.match(pendingEditChange({ path: "missing.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd).notice, /does not exist/);
	assert.match(pendingEditChange({ path: "../secret.ts", edits: [{ oldText: "secret", newText: "x" }] }, cwd).notice, /outside the working directory/);
	assert.match(pendingEditChange({ path: join(root, "secret.ts"), edits: [{ oldText: "secret", newText: "x" }] }, cwd).notice, /outside the working directory/);
	symlinkSync(join(root, "secret.ts"), join(cwd, "link.ts"));
	assert.match(pendingEditChange({ path: "link.ts", edits: [{ oldText: "secret", newText: "x" }] }, cwd).notice, /outside the working directory/, "a link out of the working directory is not followed");
	writeFileSync(join(cwd, "big.ts"), "x".repeat(1_000_001));
	assert.match(pendingEditChange({ path: "big.ts", edits: [{ oldText: "x", newText: "y" }] }, cwd).notice, /larger than 1 MB/);
	mkdirSync(join(cwd, "dir"));
	assert.match(pendingEditChange({ path: "dir", edits: [{ oldText: "x", newText: "y" }] }, cwd).notice, /not a regular file/);
	assert.match(pendingEditChange({ path: "a.ts" }, cwd).notice, /no replacements yet/);
});

test("a pending write previews a new file or the overwrite", (t) => {
	const { cwd } = workspace(t);
	assert.deepEqual(pendingWriteChange({ path: "new.md", content: "x\ny\n" }, cwd), { label: "pending create", diff: "+1 x\n+2 y" });
	const overwrite = pendingWriteChange({ path: "a.ts", content: "one\nTWO\nthree\n" }, cwd);
	assert.equal(overwrite.label, "pending overwrite");
	assert.match(overwrite.diff, /^-2 two\n\+2 TWO$/m);
	assert.match(pendingWriteChange({ path: "a.ts", content: "one\ntwo\nthree\n" }, cwd).notice, /changes nothing/);
	assert.match(pendingWriteChange({ path: "../secret.ts", content: "x" }, cwd).notice, /outside the working directory/);
	assert.match(pendingWriteChange({ path: "a.ts" }, cwd).notice, /no content yet/);
});

test("a write records what it replaced, so the change outlives the session", (t) => {
	const { cwd } = workspace(t);
	const created = writeDetails(readBeforeWrite("new.md", cwd), "x\ny\n");
	assert.deepEqual(created, { created: true }, "a new file's contents are already the call's arguments");
	assert.deepEqual(writeResultChange({ content: "x\ny\n" }, created), { label: "new file", diff: "+1 x\n+2 y" });
	assert.deepEqual(writeChanges({ content: "x\ny\n" }, created), { added: 2, removed: 0 });

	const overwrote = writeDetails(readBeforeWrite("a.ts", cwd), "one\nTWO\nthree\n");
	assert.equal(overwrote.created, false);
	assert.match(overwrote.diff, /^-2 two\n\+2 TWO$/m);
	assert.deepEqual(writeResultChange({}, overwrote), { diff: overwrote.diff });
	assert.deepEqual(writeChanges({}, overwrote), { added: 1, removed: 1 });

	writeFileSync(join(cwd, "big.ts"), "x".repeat(1_000_001));
	const big = writeDetails(readBeforeWrite("big.ts", cwd), "small");
	assert.deepEqual(big, { created: false, diffOmitted: "the file was not read because it is larger than 1 MB" });
	assert.match(writeResultChange({}, big).notice, /not shown: the file was not read because it is larger than 1 MB/);
	assert.equal(writeChanges({}, big), undefined);

	const many = "line\n".repeat(20_001);
	writeFileSync(join(cwd, "many.txt"), many.replace(/line/g, "l"));
	assert.match(writeDetails(readBeforeWrite("many.txt", cwd), many).diffOmitted, /more than 20,000 lines/);
	assert.match(writeResultChange({}, { created: false, diff: "" }).notice, /changed nothing/);
	assert.equal(writeResultChange({}, undefined), undefined, "pi's own write records nothing");
	assert.equal(writeChanges({}, {}), undefined);
});

test("a finished edit shows the diff pi recorded", () => {
	assert.deepEqual(editResultChange({ diff: "-1 a\n+1 b" }), { diff: "-1 a\n+1 b" });
	assert.match(editResultChange({ diff: "" }).notice, /changed nothing/);
	assert.equal(editResultChange({}), undefined);
});
