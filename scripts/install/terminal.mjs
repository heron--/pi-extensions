/**
 * Terminal interaction for the installer: a checkbox list drawn in the
 * alternate screen, and line prompts.
 */

import { createInterface, emitKeypressEvents } from "node:readline";

const plain = (text) => text;

/** ANSI styling, or none when `enabled` is false (NO_COLOR, or not a terminal). */
export function createStyle(enabled) {
	const wrap = (open, close) => (enabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : plain);
	return {
		plain,
		bold: wrap(1, 22),
		dim: wrap(2, 22),
		cyan: wrap(36, 39),
		green: wrap(32, 39),
		yellow: wrap(33, 39),
		red: wrap(31, 39),
	};
}

/**
 * Join `[text, paint]` segments into one row of at most `width` characters,
 * cutting the last visible segment with an ellipsis. Measuring before painting
 * keeps escape codes out of the count.
 */
export function fitRow(segments, width) {
	let remaining = width;
	let row = "";
	for (const [text, paint] of segments) {
		if (remaining <= 0) break;
		const characters = Array.from(text);
		if (characters.length <= remaining) {
			row += paint(text);
			remaining -= characters.length;
		} else {
			row += paint(`${characters.slice(0, Math.max(0, remaining - 1)).join("")}…`);
			remaining = 0;
		}
	}
	return row;
}

const HINT = "↑↓ move · space toggle · a all · enter confirm · esc cancel";

/**
 * Let the user check items in a list, drawn in the alternate screen so a
 * resize never leaves stale rows behind and the shell's screen comes back
 * untouched. `items` are `{ name, description, note, checked }`.
 *
 * Resolves to the checked names in list order, or null when cancelled with
 * Esc or q. Ctrl+C restores the terminal, then calls `onInterrupt`.
 */
export function selectFromList({ input, output, style, title, subtitle, items, onInterrupt }) {
	return new Promise((resolvePromise) => {
		const checked = new Set(items.filter((item) => item.checked).map((item) => item.name));
		const nameWidth = Math.max(...items.map((item) => item.name.length));
		let cursor = 0;
		let offset = 0;

		const render = () => {
			const width = Math.max(10, (output.columns || 80) - 1);
			const rows = Math.max(6, output.rows || 24);
			const lines = [fitRow([[title, style.bold]], width), fitRow([[subtitle, style.dim]], width), ""];
			const visible = Math.max(1, rows - lines.length - 2);
			// Fill the window, then scroll it just enough to keep the cursor in it.
			offset = Math.max(0, Math.min(offset, items.length - visible));
			offset = Math.min(Math.max(offset, cursor - visible + 1), cursor);
			for (const [index, item] of items.slice(offset, offset + visible).entries()) {
				const here = offset + index === cursor;
				lines.push(
					fitRow(
						[
							[here ? "> " : "  ", style.cyan],
							[checked.has(item.name) ? "[x] " : "[ ] ", here ? style.cyan : plain],
							[item.name.padEnd(nameWidth), here ? style.bold : plain],
							["  ", plain],
							...(item.note ? [[`${item.note}  `, style.yellow]] : []),
							[item.description, style.dim],
						],
						width,
					),
				);
			}
			const position = items.length > visible ? `${cursor + 1}/${items.length} · ` : "";
			lines.push("", fitRow([[position + HINT, style.dim]], width));
			output.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
		};

		const restore = () => output.write("\x1b[?25h\x1b[?1049l");
		const finish = (result, interrupted = false) => {
			input.off("keypress", onKey);
			output.off("resize", render);
			process.off("exit", restore);
			input.setRawMode(false);
			input.pause();
			restore();
			if (interrupted) onInterrupt();
			resolvePromise(result);
		};

		const onKey = (_text, key = {}) => {
			if (key.ctrl && key.name === "c") return finish(null, true);
			switch (key.name) {
				case "up":
				case "k":
					cursor = (cursor - 1 + items.length) % items.length;
					break;
				case "down":
				case "j":
					cursor = (cursor + 1) % items.length;
					break;
				case "space": {
					const { name } = items[cursor];
					if (checked.has(name)) checked.delete(name);
					else checked.add(name);
					break;
				}
				case "a":
					if (checked.size === items.length) checked.clear();
					else for (const item of items) checked.add(item.name);
					break;
				case "return":
				case "enter":
					return finish(items.filter((item) => checked.has(item.name)).map((item) => item.name));
				case "escape":
				case "q":
					return finish(null);
				default:
					return;
			}
			render();
		};

		emitKeypressEvents(input);
		input.setRawMode(true);
		input.resume();
		input.on("keypress", onKey);
		output.on("resize", render);
		process.on("exit", restore);
		output.write("\x1b[?1049h\x1b[?25l");
		render();
	});
}

/**
 * Line prompts on a terminal. `ask` resolves to the typed line, or null once
 * input has ended (Ctrl+D); Ctrl+C calls `onInterrupt`.
 */
export function createPrompter({ input, output, onInterrupt }) {
	const lines = createInterface({ input, output, terminal: true });
	let ended = false;
	let settle;
	lines.on("close", () => {
		ended = true;
		settle?.(null);
	});
	lines.on("SIGINT", () => {
		output.write("\n");
		lines.close();
		onInterrupt();
	});

	const ask = (question) =>
		ended
			? Promise.resolve(null)
			: new Promise((resolvePromise) => {
					settle = resolvePromise;
					lines.question(question, (answer) => {
						settle = undefined;
						resolvePromise(answer);
					});
				});

	/** A yes/no question; Enter takes the default, ended input means no. */
	const confirm = async (question, defaultYes = false) => {
		for (;;) {
			const answer = await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
			if (answer === null) return false;
			const text = answer.trim();
			if (!text) return defaultYes;
			if (/^y(es)?$/i.test(text)) return true;
			if (/^no?$/i.test(text)) return false;
			output.write("  Answer y or n.\n");
		}
	};

	/** Run `action` with the terminal out of raw mode, so a child process can use it (and Ctrl+C reaches it). */
	const suspended = (action) => {
		lines.pause();
		input.setRawMode(false);
		try {
			return action();
		} finally {
			input.setRawMode(true);
			lines.resume();
		}
	};

	return { ask, confirm, suspended, close: () => lines.close() };
}
