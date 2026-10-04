import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plain } from "./harness.mjs";
import { clipToWidth, sanitizeStatus } from "./status.ts";

const LINK = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
const both = (text) => ["normalized", "producer"].map((mode) => sanitizeStatus(text, mode));

/** No escape sequence other than SGR and OSC 8 survives. */
function assertOnlySafeEscapes(text) {
	const rest = text.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*\x07/g, "");
	assert.doesNotMatch(rest, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(text));
}

/** Every SGR is reset and every link closed by the end. */
function assertClosed(text) {
	const sgr = [...text.matchAll(/\x1b\[([0-9;:]*)m/g)];
	if (sgr.length > 0) assert.match(sgr.at(-1)[1], /^0?$/, `unreset style: ${JSON.stringify(text)}`);
	const links = [...text.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)];
	if (links.length > 0) assert.equal(links.at(-1)[1], "", `unclosed link: ${JSON.stringify(text)}`);
}

test("plain text passes through, one line, collapsed and trimmed", () => {
	assert.deepEqual(both("  ready\n\tnow\r\n  "), ["ready now", "ready now"]);
});

test("zero, error and freshness wording are ordinary text", () => {
	for (const text of ["$0.00", "0", "error: gateway 503", "stale 5m"]) assert.deepEqual(both(text), [text, text]);
});

test("styling-only and blank text is unavailable", () => {
	for (const text of ["", "   ", "\x1b[31m\x1b[0m", "\x1b[44m  \x1b[0m", "\n\t", "\x1b]0;title\x07"]) {
		assert.deepEqual(both(text), ["", ""], JSON.stringify(text));
	}
});

test("normalized mode drops producer colors; producer mode keeps them and resets at the end", () => {
	const pill = "\x1b[44;38;2;10;20;30m 2 tasks \x1b[49m";
	const [normalized, producer] = both(pill);
	assert.equal(normalized, "2 tasks");
	assert.equal(producer, "\x1b[44;38;2;10;20;30m 2 tasks \x1b[49m\x1b[0m");
	assertClosed(producer);
	assert.equal(sanitizeStatus("\x1b[1mbold", "producer"), "\x1b[1mbold\x1b[0m");
});

test("cursor, erase, title, clipboard and other control sequences never survive", () => {
	const hostile = [
		"a\x1b[2Jb", "a\x1b[10;5Hb", "a\x1b[?25lb", "a\x1b[Kb", "a\x1b]0;evil title\x07b", "a\x1b]52;c;ZXZpbA==\x07b",
		"a\x1bPq#0;2;0;0;0\x1b\\b", "a\x1b_apc\x1b\\b", "a\x1b7b", "a\x1bcb", "a\x9b2Jb", "a\x07\x08\x7fb", "a\x1b[38;5;1 qb",
	];
	for (const text of hostile) {
		for (const result of both(text)) {
			assert.equal(plain(result), "ab", JSON.stringify(text));
			assertOnlySafeEscapes(result);
		}
	}
});

test("an unterminated string sequence drops the rest instead of swallowing the frame", () => {
	assert.deepEqual(both("ok\x1b]0;never ends"), ["ok", "ok"]);
	assert.deepEqual(both("ok\x1b[12"), ["ok", "ok"]);
});

test("http(s) links survive in both modes and are closed", () => {
	const text = `see ${LINK("https://example.com/a", "#4")}`;
	for (const result of both(text)) {
		assert.ok(result.includes("\x1b]8;;https://example.com/a\x07#4\x1b]8;;\x07"), JSON.stringify(result));
		assertClosed(result);
	}
	const unclosed = sanitizeStatus("\x1b]8;;http://example.com\x07dangling", "normalized");
	assert.equal(unclosed, "\x1b]8;;http://example.com\x07dangling\x1b]8;;\x07");
});

test("links to other schemes lose the link but keep their text", () => {
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "https://bad\x1bhost"]) {
		for (const result of both(LINK(url, "label"))) {
			assert.equal(plain(result), "label");
			assert.doesNotMatch(result, /\x1b\]8;;[^\x07]/, url);
		}
	}
});

test("emoji, wide and combining characters keep their visible width", () => {
	for (const text of ["👍🏽 done", "日本語", "été", "🇯🇵 flag"]) {
		const [normalized] = both(text);
		assert.equal(normalized, text);
		assert.equal(visibleWidth(normalized), visibleWidth(text));
	}
});

test("clipping honours visible columns and leaks no style or link", () => {
	const cases = [
		sanitizeStatus("\x1b[31mred text that runs long\x1b[39m", "producer"),
		sanitizeStatus(`${LINK("https://example.com", "a long linked label")} after`, "producer"),
		"日本語のテキスト",
		"👍🏽👍🏽👍🏽👍🏽👍🏽",
	];
	for (const text of cases) {
		for (const width of [1, 3, 5, 8]) {
			const clipped = clipToWidth(text, width);
			assert.ok(visibleWidth(clipped) <= width, `${JSON.stringify(clipped)} > ${width}`);
			assertClosed(clipped);
			assertOnlySafeEscapes(clipped);
		}
	}
	assert.equal(clipToWidth("short", 10), "short");
	assert.equal(clipToWidth("long text", undefined), "long text");
});
