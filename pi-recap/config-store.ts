import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const CONFIG_LOCK_STALE_MS = 60_000;
const CONFIG_LOCK_RETRIES = 100;
const CONFIG_LOCK_RETRY_MS = 10;

export interface StoredRecapConfig {
	markers?: { recap?: string; next?: string };
	style?: string;
	rotationIndex?: number;
	intervalMinutes?: number;
	minimumCompletedInteractions?: number;
	[key: string]: unknown;
}

export type RecapConfigPatch = Partial<Omit<StoredRecapConfig, "markers">> & {
	markers?: { recap?: string; next?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleepSync(milliseconds: number): void {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

export function readRecapConfig(path: string): StoredRecapConfig {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

function mergeConfig(current: StoredRecapConfig, patch: RecapConfigPatch): StoredRecapConfig {
	const merged: StoredRecapConfig = { ...current, ...patch };
	if (patch.markers) {
		const currentMarkers = isRecord(current.markers) ? current.markers : {};
		merged.markers = { ...currentMarkers, ...patch.markers };
	}
	return merged;
}

export function updateRecapConfig(
	path: string,
	update: RecapConfigPatch | ((current: StoredRecapConfig) => RecapConfigPatch),
): StoredRecapConfig {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;

	for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt += 1) {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(lockPath, "wx");
			try {
				const current = readRecapConfig(path);
				const patch = typeof update === "function" ? update(current) : update;
				const merged = mergeConfig(current, patch);
				writeJsonAtomic(path, merged);
				return merged;
			} finally {
				closeSync(descriptor);
				try {
					unlinkSync(lockPath);
				} catch {
					// A stale-lock cleaner may already have removed it.
				}
			}
		} catch (error) {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// The descriptor was already closed.
				}
			}
			const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
			if (code !== "EEXIST") throw error;

			try {
				if (Date.now() - statSync(lockPath).mtimeMs > CONFIG_LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue;
			}
			sleepSync(CONFIG_LOCK_RETRY_MS);
		}
	}

	throw new Error(`Timed out waiting for recap config lock: ${lockPath}`);
}
