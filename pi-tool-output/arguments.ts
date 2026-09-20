import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const CALL_LIMITS = {
	inlineChars: 160,
	fields: 8,
	collapsedRows: 3,
	expandedChars: 16_000,
	expandedRows: 120,
} as const;

/**
 * Generated stand-ins for content that is not shown, and the single source of
 * truth for both writing and recognizing them.
 *
 * Renderers match these exactly, so a literal value that merely looks like a
 * label — a `[abc]` character class, a `--flag=[x]` argument — keeps the plain
 * value color.
 */
export const ARGUMENT_PLACEHOLDERS = {
	accessor: "[accessor]",
	argumentsUnavailable: "[arguments unavailable]",
	circular: "[circular]",
	depthLimit: "[depth limit]",
	function: "[function]",
	inlineScript: "<inline script>",
	largeValue: "[large value]",
	longArgument: "<long argument>",
	symbol: "[symbol]",
	unavailable: "[unavailable]",
} as const;

export interface ArgumentPreview {
	text: string;
	hidden: boolean;
}

/** Terminal data is never allowed to supply styles or cursor/control commands. */
export function cleanArgumentText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function shortArgument(text: string, maximum = CALL_LIMITS.inlineChars as number): string {
	const clipped = text.length > maximum;
	return cleanArgumentText(text.slice(0, maximum)).replace(/\s+/g, " ").trim() + (clipped ? "…" : "");
}

function ownValue(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor ? ("value" in descriptor ? descriptor.value : ARGUMENT_PLACEHOLDERS.accessor) : undefined;
}

function* enumerableKeys(object: object): Generator<string> {
	if (Array.isArray(object)) {
		for (let index = 0; index < object.length; index++) yield String(index);
	} else {
		for (const key in object) if (Object.hasOwn(object, key)) yield key;
	}
}

function keysUpTo(object: object, maximum: number): { keys: string[]; more: boolean } {
	const keys: string[] = [];
	for (const key of enumerableKeys(object)) {
		if (keys.length === maximum) return { keys, more: true };
		keys.push(key);
	}
	return { keys, more: false };
}

/** Bounded traversal, not JSON.stringify(payload). Never invokes toJSON or getters. */
function serialize(value: unknown, maximum: number, pretty = false): ArgumentPreview {
	let text = "";
	let hidden = false;
	let stopped = false;
	let nodes = 0;
	const parents = new Set<object>();
	function append(part: string): void {
		const remaining = maximum - text.length;
		if (part.length > remaining) {
			text += part.slice(0, remaining);
			hidden = stopped = true;
		} else text += part;
	}
	function visit(item: unknown, depth: number): void {
		if (stopped) return;
		if (++nodes > (pretty ? 2000 : 40)) {
			hidden = stopped = true;
			return;
		}
		if (typeof item === "string") {
			// Slice before cleaning/escaping so a single huge leaf cannot defeat the budget.
			const remaining = maximum - text.length;
			append(JSON.stringify(cleanArgumentText(item.slice(0, remaining))));
			if (item.length > remaining) hidden = stopped = true;
		} else if (item === null || typeof item !== "object") {
			append(typeof item === "function" ? ARGUMENT_PLACEHOLDERS.function : typeof item === "symbol" ? ARGUMENT_PLACEHOLDERS.symbol : typeof item === "bigint" ? `${item}n` : String(item));
		} else if (parents.has(item) || depth >= (pretty ? 8 : 4)) {
			append(parents.has(item) ? ARGUMENT_PLACEHOLDERS.circular : ARGUMENT_PLACEHOLDERS.depthLimit);
			hidden = true;
		} else {
			parents.add(item);
			const array = Array.isArray(item);
			append(array ? "[" : "{");
			let count = 0;
			for (const key of enumerableKeys(item)) {
				if (stopped) break;
				if (count++) append(pretty ? ",\n" : ",");
				else if (pretty) append("\n");
				if (pretty) append("  ".repeat(depth + 1));
				if (!array) {
					append(JSON.stringify(shortArgument(key)));
					if (key.length > CALL_LIMITS.inlineChars) hidden = true;
					append(pretty ? ": " : ":");
				}
				visit(ownValue(item, key), depth + 1);
			}
			if (pretty && count) append(`\n${"  ".repeat(depth)}`);
			append(array ? "]" : "}");
			parents.delete(item);
		}
	}
	try {
		visit(value, 0);
	} catch {
		hidden = true;
		append(ARGUMENT_PLACEHOLDERS.unavailable);
	}
	return { text, hidden };
}

function stringSize(value: string): string {
	const bytes = Buffer.byteLength(value, "utf8");
	const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
	let lines = 1;
	for (let index = 0; index < value.length; index++) if (value[index] === "\n") lines++;
	return `${size} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/**
 * A run of preview text that renderers may color on its own.
 *
 * `measure` is a magnitude, `unit` its unit or noun (`KB`, `lines`, `array`),
 * `separator` the ` · ` inside a descriptor, and `placeholder` a generated label
 * standing in for content that is not shown. `text` is the value as written.
 */
export type ArgumentSpanKind = "text" | "measure" | "unit" | "separator" | "placeholder";

export interface ArgumentSpan {
	kind: ArgumentSpanKind;
	text: string;
}

/**
 * Descriptors this module generates, as whole-value patterns paired with the
 * span kind of each capture group. The literal text between captures is
 * recovered from the match itself, so a span list always rebuilds the original
 * string regardless of where a descriptor places its separator.
 */
const DESCRIPTOR_PATTERNS: readonly { pattern: RegExp; kinds: readonly ArgumentSpanKind[] }[] = [
	// `288 B · 1 line`
	{ pattern: /^(\d+(?:\.\d+)?) (B|KB) · (\d+) (lines?)$/, kinds: ["measure", "unit", "measure", "unit"] },
	// `array · 10000 items`
	{ pattern: /^(array) · (\d+) (items?)$/, kinds: ["unit", "measure", "unit"] },
	// `object · 100+ fields`
	{ pattern: /^(object) · (\d+\+?) (fields?)$/, kinds: ["unit", "measure", "unit"] },
];

const PLACEHOLDER_LABEL = new RegExp(
	Object.values(ARGUMENT_PLACEHOLDERS)
		.slice()
		.sort((left, right) => right.length - left.length)
		.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|"),
	"g",
);

/**
 * Captures as typed spans, with the literal text between them preserved. Text
 * containing the descriptor separator becomes a `separator` span; a plain gap
 * stays `text`.
 */
function descriptorSpans(match: RegExpMatchArray, kinds: readonly ArgumentSpanKind[]): ArgumentSpan[] {
	const source = match[0];
	const spans: ArgumentSpan[] = [];
	let cursor = 0;
	for (const [index, kind] of kinds.entries()) {
		const capture = match[index + 1];
		if (capture === undefined) continue;
		const start = source.indexOf(capture, cursor);
		if (start < 0) continue;
		if (start > cursor) {
			const between = source.slice(cursor, start);
			spans.push({ kind: between.includes("·") ? "separator" : "text", text: between });
		}
		spans.push({ kind, text: capture });
		cursor = start + capture.length;
	}
	if (cursor < source.length) {
		const tail = source.slice(cursor);
		spans.push({ kind: tail.includes("·") ? "separator" : "text", text: tail });
	}
	return spans;
}

function placeholderSpans(text: string): ArgumentSpan[] {
	const spans: ArgumentSpan[] = [];
	let cursor = 0;
	for (const match of text.matchAll(PLACEHOLDER_LABEL)) {
		if (match.index > cursor) spans.push({ kind: "text", text: text.slice(cursor, match.index) });
		spans.push({ kind: "placeholder", text: match[0] });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) spans.push({ kind: "text", text: text.slice(cursor) });
	return spans;
}

/**
 * Split preview text into spans a renderer can color individually.
 *
 * A value that is entirely one generated descriptor splits into its measures,
 * units, and separators. Any other text keeps its generated labels as
 * `placeholder` spans and is otherwise a single `text` span, so literal values
 * are never reinterpreted.
 */
export function argumentSpans(text: string): ArgumentSpan[] {
	if (!text) return [];
	for (const { pattern, kinds } of DESCRIPTOR_PATTERNS) {
		const match = text.match(pattern);
		if (match) return descriptorSpans(match, kinds);
	}
	return placeholderSpans(text);
}

function compactValue(value: unknown): ArgumentPreview {
	if (typeof value === "string") {
		if (value.length > CALL_LIMITS.inlineChars || /[\r\n]/.test(value)) {
			return { text: stringSize(value), hidden: true };
		}
		return { text: shortArgument(value) || '\"\"', hidden: false };
	}
	const inline = serialize(value, CALL_LIMITS.inlineChars);
	if (!inline.hidden) return inline;
	if (Array.isArray(value)) return { text: `array · ${value.length} items`, hidden: true };
	if (value && typeof value === "object") {
		const { keys, more } = keysUpTo(value, 100);
		return { text: `object · ${keys.length}${more ? "+" : ""} fields`, hidden: true };
	}
	return { text: ARGUMENT_PLACEHOLDERS.largeValue, hidden: true };
}

/** Consumed fields are omitted only when their value fits the semantic summary. */
export function compactArguments(args: unknown, consumed: readonly string[] = []): ArgumentPreview {
	try {
		if (!args || typeof args !== "object" || Array.isArray(args)) return compactValue(args);
		const { keys, more } = keysUpTo(args, CALL_LIMITS.fields);
		let hidden = more;
		const parts: string[] = [];
		for (const key of keys) {
			const value = compactValue(ownValue(args, key));
			hidden ||= value.hidden || key.length > CALL_LIMITS.inlineChars;
			if (!consumed.includes(key) || value.hidden) parts.push(`${shortArgument(key)}: ${value.text}`);
		}
		if (more) parts.push("… more arguments");
		return { text: parts.join(" · ") || (keys.length ? "" : "(no arguments)"), hidden };
	} catch {
		return { text: ARGUMENT_PLACEHOLDERS.argumentsUnavailable, hidden: true };
	}
}

export function formatToolArguments(args: unknown): string {
	return compactArguments(args).text;
}

/** Top-level strings keep newlines; structured values get a bounded tree preview. */
export function expandedArguments(args: unknown): ArgumentPreview {
	try {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return serialize(args, CALL_LIMITS.expandedChars, true);
		}
		const { keys, more } = keysUpTo(args, 100);
		let text = "";
		let hidden = more;
		for (const key of keys) {
			if (text.length >= CALL_LIMITS.expandedChars) {
				hidden = true;
				break;
			}
			const value = ownValue(args, key);
			const label = `${shortArgument(key)}: `;
			const budget = Math.max(0, CALL_LIMITS.expandedChars - text.length - label.length - 1);
			const preview = typeof value === "string"
				? { text: cleanArgumentText(value.slice(0, budget)), hidden: value.length > budget }
				: serialize(value, budget, true);
			text += `${text ? "\n" : ""}${label}${preview.text}`;
			hidden ||= preview.hidden || key.length > CALL_LIMITS.inlineChars;
		}
		return { text: text.slice(0, CALL_LIMITS.expandedChars) || "(no arguments)", hidden: hidden || text.length > CALL_LIMITS.expandedChars };
	} catch {
		return { text: ARGUMENT_PLACEHOLDERS.argumentsUnavailable, hidden: true };
	}
}
