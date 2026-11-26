/**
 * What a tool's result amounts to, in a few words for the end of its row:
 * "12 matches", "3 tables". The row shows it before the size of the output.
 */
import { extractTextOutput } from "./rendering.ts";

type Fields = Record<string, unknown>;

/** The largest result text parsed as JSON; a bigger one shows only its size. */
const MAX_PARSED_CHARS = 2_000_000;

function record(value: unknown): Fields | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
}

function count(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

function jsonOutput(result: Parameters<typeof extractTextOutput>[0]): Fields | undefined {
	const text = extractTextOutput(result).trim();
	if (!text.startsWith("{") || text.length > MAX_PARSED_CHARS) return undefined;
	try {
		return record(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function duration(minutes: unknown): string | undefined {
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return undefined;
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${Math.round(minutes)} min`;
	const hours = Math.floor(minutes / 60);
	const rest = Math.round(minutes % 60);
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Trajectory answers `ok: false` with a message instead of failing the call. */
function trajectoryRows(output: Fields, noun: string, pluralForm?: string): string | undefined {
	if (output.ok === false) return "failed";
	const rows = count(output.rows);
	if (rows === undefined) return undefined;
	const meta = record(output.meta);
	const more = meta?.truncated === true || output.truncated === true;
	return rows === 0 ? `no ${pluralForm ?? `${noun}s`}` : `${plural(rows, noun, pluralForm)}${more ? ", more not shown" : ""}`;
}

function summarizeTrajectory(name: string, output: Fields): string | undefined {
	switch (name) {
		case "trajectory_search":
			return trajectoryRows(output, "match", "matches");
		case "trajectory_query":
			return trajectoryRows(output, "row");
		case "trajectory_schema": {
			if (output.ok === false) return "failed";
			const tables = count(output.tables);
			return tables === undefined ? undefined : plural(tables, "table");
		}
		case "get_session_trajectory": {
			const events = count(output.events);
			if (events !== undefined) return plural(events, "event");
			const turns = typeof output.turns === "number" ? output.turns : count(output.turns);
			if (turns === undefined) return undefined;
			const length = duration(output.duration_minutes);
			return `${plural(turns, "turn")}${length ? ` over ${length}` : ""}`;
		}
		case "trajectory_status": {
			if (typeof output.status !== "string") return undefined;
			// Sections that need attention carry a `fix` instruction.
			const notices = Object.values(output).filter((section) => typeof record(section)?.fix === "string").length;
			const sessions = typeof output.sessions_active === "number" ? `, ${plural(output.sessions_active, "active session")}` : "";
			return `${output.status}${sessions}${notices ? `, ${plural(notices, "notice")}` : ""}`;
		}
		default:
			return undefined;
	}
}

/** The datadog proxy describes its result in `details.state`. */
function summarizeDatadog(details: unknown): string | undefined {
	const fields = record(details);
	switch (fields?.state) {
		case "listed": {
			const shown = typeof fields.count === "number" ? fields.count : undefined;
			const total = typeof fields.total === "number" ? fields.total : undefined;
			if (shown === undefined) return undefined;
			return total !== undefined && total !== shown ? `${shown} of ${plural(total, "tool")}` : plural(shown, "tool");
		}
		case "not-setup":
			return "not signed in";
		default:
			return undefined;
	}
}

/** A few words on what a finished call returned, or undefined when only its size says anything. */
export function summarizeToolResult(name: string, result: { content?: unknown; details?: unknown; isError?: boolean } | undefined): string | undefined {
	if (!result || result.isError === true) return undefined;
	if (name === "datadog") return summarizeDatadog(result.details);
	if (name.startsWith("trajectory_") || name === "get_session_trajectory") {
		const output = jsonOutput(result);
		return output ? summarizeTrajectory(name, output) : undefined;
	}
	return undefined;
}
