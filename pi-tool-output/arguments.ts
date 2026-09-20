import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const CALL_LIMITS = {
	inlineChars: 160,
	fields: 8,
	collapsedRows: 3,
	expandedChars: 16_000,
	expandedRows: 120,
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
	return descriptor ? ("value" in descriptor ? descriptor.value : "[accessor]") : undefined;
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
			append(typeof item === "function" ? "[function]" : typeof item === "symbol" ? "[symbol]" : typeof item === "bigint" ? `${item}n` : String(item));
		} else if (parents.has(item) || depth >= (pretty ? 8 : 4)) {
			append(parents.has(item) ? "[circular]" : "[depth limit]");
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
		append("[unavailable]");
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
	return { text: "[large value]", hidden: true };
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
		return { text: "[arguments unavailable]", hidden: true };
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
		return { text: "[arguments unavailable]", hidden: true };
	}
}
