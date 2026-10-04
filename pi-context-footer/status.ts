/**
 * Status text as display content: making a producer's string safe for one
 * cell run of the frame, in either presentation mode. Nothing here reads
 * meaning into the text — no amounts, states or icons are derived from it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type Presentation = "normalized" | "producer";

const LINK_CLOSE = "\x1b]8;;\x07";
const RESET = "\x1b[0m";
/** SGR parameters: digits separated by `;` or `:` (truecolor and underline styles). */
const SGR_PARAMS = /^[0-9;:]*$/;
/** Link targets a status may carry. Anything else keeps its text and loses the link. */
const LINK_SCHEMES = /^(https?):\/\//i;
/** The sequences sanitizeStatus keeps. */
const KEPT_ESCAPES = /\x1b\[[0-9;:]*m|\x1b\]8;;[^\x07]*\x07/g;

/**
 * Reduce status text to one safe line.
 *
 * - Line breaks and tabs become spaces, runs of spaces collapse, and the ends
 *   are trimmed, as pi's own footer does.
 * - Other C0 and C1 controls and DEL are removed.
 * - Escape sequences are removed except SGR (kept in producer mode only) and
 *   OSC 8 links to http(s) URLs (kept in both). Cursor movement, erasing,
 *   titles, clipboard writes and the rest never reach the terminal.
 * - Whatever styling or link is still open at the end is closed, so the text
 *   cannot bleed into the next item, the frame or the input.
 *
 * Returns "" when nothing visible remains.
 */
export function sanitizeStatus(text: string, presentation: Presentation): string {
	// 8-bit C1 introducers are read as their 7-bit forms, so `\x9b2J` is parsed
	// (and dropped) as a whole sequence rather than leaving `2J` behind.
	text = text.replace(/[\x90\x98\x9b\x9c\x9d\x9e\x9f]/g, (c1) => `\x1b${String.fromCharCode(c1.charCodeAt(0) - 0x40)}`);
	let out = "";
	let styled = false;
	let linkOpen = false;
	let index = 0;

	// The end of an ESC-introduced string: BEL or ST (ESC \), or null when unterminated.
	const stringEnd = (from: number): { end: number; next: number } | null => {
		for (let at = from; at < text.length; at++) {
			if (text[at] === "\x07") return { end: at, next: at + 1 };
			if (text[at] === "\x1b" && text[at + 1] === "\\") return { end: at, next: at + 2 };
		}
		return null;
	};

	while (index < text.length) {
		const char = text[index]!;
		const code = char.charCodeAt(0);

		if (char === "\x1b") {
			const kind = text[index + 1];
			if (kind === "[") {
				// CSI: parameters, intermediates, one final byte.
				const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(text.slice(index));
				if (!match) {
					index = text.length;
					continue;
				}
				const [whole, params, intermediates, final] = match;
				if (presentation === "producer" && final === "m" && intermediates === "" && SGR_PARAMS.test(params!)) {
					out += whole;
					styled = true;
				}
				index += whole!.length;
				continue;
			}
			if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
				const terminated = stringEnd(index + 2);
				if (!terminated) {
					// An unterminated string would swallow everything after it.
					index = text.length;
					continue;
				}
				if (kind === "]") {
					const body = text.slice(index + 2, terminated.end);
					const link = /^8;[^;]*;(.*)$/s.exec(body);
					if (link) {
						const url = link[1]!;
						if (url === "") {
							if (linkOpen) out += LINK_CLOSE;
							linkOpen = false;
						} else if (LINK_SCHEMES.test(url) && !/[\x00-\x20\x7f-\x9f]/.test(url)) {
							if (linkOpen) out += LINK_CLOSE;
							out += `\x1b]8;;${url}\x07`;
							linkOpen = true;
						}
					}
				}
				index = terminated.next;
				continue;
			}
			// Any other escape: drop ESC and the byte after it.
			index += 2;
			continue;
		}

		if (char === "\n" || char === "\r" || char === "\t") {
			out += " ";
		} else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			out += char;
		}
		index++;
	}

	// Like pi's own footer: collapse and trim the raw string, so a producer's
	// padded pill keeps its padding in producer mode. Kept escapes hold no spaces.
	out = out.replace(/ {2,}/g, " ").trim();
	// Styling around nothing but spaces is still nothing to read.
	if (out.replace(KEPT_ESCAPES, "").trim() === "") return "";
	if (linkOpen) out += LINK_CLOSE;
	if (styled) out += RESET;
	return out;
}

/** Clip to a width limit with `…`; truncateToWidth closes styles and links it cuts. */
export function clipToWidth(text: string, maxWidth: number | undefined): string {
	if (maxWidth === undefined || visibleWidth(text) <= maxWidth) return text;
	return truncateToWidth(text, maxWidth, "…");
}
