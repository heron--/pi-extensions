export const DEFAULT_INTERVAL_MINUTES = 5;
export const MIN_INTERVAL_MINUTES = 0.05;
export const MAX_INTERVAL_MINUTES = 240;
export const DEFAULT_MINIMUM_COMPLETED_INTERACTIONS = 5;
export const MIN_COMPLETED_INTERACTIONS = 1;
export const MAX_COMPLETED_INTERACTIONS = 1_000;

export interface RecapSettings {
	intervalMinutes: number;
	minimumCompletedInteractions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRecapSettings(value: unknown): RecapSettings {
	const stored = isRecord(value) ? value : {};
	const intervalMinutes = stored.intervalMinutes;
	const minimumCompletedInteractions = stored.minimumCompletedInteractions;

	return {
		intervalMinutes:
			typeof intervalMinutes === "number" && isValidIntervalMinutes(intervalMinutes)
				? intervalMinutes
				: DEFAULT_INTERVAL_MINUTES,
		minimumCompletedInteractions:
			typeof minimumCompletedInteractions === "number" &&
			Number.isInteger(minimumCompletedInteractions) &&
			minimumCompletedInteractions >= MIN_COMPLETED_INTERACTIONS &&
			minimumCompletedInteractions <= MAX_COMPLETED_INTERACTIONS
				? minimumCompletedInteractions
				: DEFAULT_MINIMUM_COMPLETED_INTERACTIONS,
	};
}

export function isValidIntervalMinutes(value: number): boolean {
	return Number.isFinite(value) && value >= MIN_INTERVAL_MINUTES && value <= MAX_INTERVAL_MINUTES;
}

export function isValidMinimumCompletedInteractions(value: number): boolean {
	return (
		Number.isInteger(value) &&
		value >= MIN_COMPLETED_INTERACTIONS &&
		value <= MAX_COMPLETED_INTERACTIONS
	);
}
