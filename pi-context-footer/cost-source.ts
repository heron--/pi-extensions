import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** In-process protocol: providers answer asynchronously without owning the footer. */
export const COST_REQUEST_EVENT = "pi-context-footer:cost-request:v1";
export const COST_REQUEST_TIMEOUT_MS = 45_000;

export interface CostSnapshot {
	/** USD for the whole session; null means no usable external estimate. */
	costUsd: number | null;
	partial?: boolean;
}

export interface CostRequest {
	source: string;
	sessionId: string;
	signal: AbortSignal;
	respond: (snapshot: CostSnapshot) => void;
}

export interface CostSourceSettings {
	id: string;
	refreshSeconds: number;
}

export function parseCostSourceSettings(value: unknown): CostSourceSettings | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error('"costSource" must be an object');
	const { id, refreshSeconds = 60 } = value as { id?: unknown; refreshSeconds?: unknown };
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || id === "local") {
		throw new Error('"costSource.id" must be a source identifier (not "local")');
	}
	if (typeof refreshSeconds !== "number" || !Number.isFinite(refreshSeconds) || refreshSeconds < 15 || refreshSeconds > 3600) {
		throw new Error('"costSource.refreshSeconds" must be between 15 and 3600');
	}
	return { id, refreshSeconds };
}

function validSnapshot(value: unknown): value is CostSnapshot {
	if (!value || typeof value !== "object") return false;
	const { costUsd, partial } = value as CostSnapshot;
	return (costUsd === null || (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0))
		&& (partial === undefined || typeof partial === "boolean");
}

/** A single non-overlapping request loop. Rendering only reads the snapshot. */
export class CostSourcePoller {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private controller: AbortController | undefined;
	private active = false;
	private snapshot: CostSnapshot | null = null;

	private readonly events: ExtensionAPI["events"];
	private readonly settings: CostSourceSettings;
	private readonly sessionId: string;
	private readonly onUpdate: () => void;

	constructor(events: ExtensionAPI["events"], settings: CostSourceSettings, sessionId: string, onUpdate: () => void) {
		this.events = events;
		this.settings = settings;
		this.sessionId = sessionId;
		this.onUpdate = onUpdate;
	}

	getSnapshot(): CostSnapshot | null {
		return this.snapshot;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		// Defer the first request so other extensions can finish session_start.
		this.schedule(0);
	}

	stop(): void {
		this.active = false;
		clearTimeout(this.timer);
		this.timer = undefined;
		const controller = this.controller;
		this.controller = undefined;
		controller?.abort();
		this.snapshot = null;
	}

	private schedule(delay: number): void {
		this.timer = setTimeout(() => this.request(), delay);
		this.timer.unref?.();
	}

	private request(): void {
		if (!this.active) return;
		const controller = new AbortController();
		this.controller = controller;
		const finish = () => {
			if (this.controller !== controller || !this.active) return;
			clearTimeout(this.timer);
			this.controller = undefined;
			controller.abort();
			this.schedule(this.settings.refreshSeconds * 1000);
		};
		this.timer = setTimeout(finish, COST_REQUEST_TIMEOUT_MS);
		this.timer.unref?.();
		try {
			this.events.emit(COST_REQUEST_EVENT, {
				source: this.settings.id,
				sessionId: this.sessionId,
				signal: controller.signal,
				respond: (snapshot: CostSnapshot) => {
					if (this.controller !== controller || !this.active || !validSnapshot(snapshot)) return;
					// Copy plain data; a provider cannot mutate the cached value later.
					this.snapshot = { costUsd: snapshot.costUsd, partial: snapshot.partial === true };
					finish();
					this.onUpdate();
				},
			} satisfies CostRequest);
		} catch {
			// Missing/broken sources preserve the last value, or the local fallback.
			finish();
		}
	}
}
