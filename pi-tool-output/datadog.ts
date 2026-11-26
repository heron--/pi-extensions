/**
 * The chart a Datadog visualization call draws. The datadog proxy keeps the
 * screenshot of a rendered widget in `details.subtoolData.screenshot`, not in
 * the result content, so pi does not draw it. The group counts it on the
 * call's row and draws it under the box when the call is expanded, as it does
 * an image in the content.
 */
import { getCapabilities, Image, type Component } from "@earendil-works/pi-tui";

export interface Chart {
	data: string;
	mimeType: string;
}

/** The proxy's own chart size, in terminal cells. */
const CHART_SIZE = { maxWidthCells: 160, maxHeightCells: 24 };

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The screenshot in a datadog result's details, if the call drew one. */
export function datadogChart(details: unknown): Chart | undefined {
	const fields = record(details);
	if (fields?.state !== "called" || fields.isError === true) return undefined;
	const screenshot = record(record(fields.subtoolData)?.screenshot);
	const data = screenshot?.data;
	const mimeType = screenshot?.mimeType;
	return typeof data === "string" && data && typeof mimeType === "string" && mimeType.startsWith("image/")
		? { data, mimeType }
		: undefined;
}

const charts = new WeakMap<object, { chart: Chart; image: Image }>();

/**
 * The image component for a member's chart, kept per owner so a redraw reuses
 * the encoded image. Undefined when the terminal cannot draw images.
 */
export function chartComponent(owner: object, details: unknown): Component | undefined {
	const chart = datadogChart(details);
	if (!chart || !getCapabilities().images) return undefined;
	const cached = charts.get(owner);
	if (cached && cached.chart.data === chart.data && cached.chart.mimeType === chart.mimeType) return cached.image;
	const image = new Image(chart.data, chart.mimeType, { fallbackColor: (text) => text }, CHART_SIZE);
	charts.set(owner, { chart, image });
	return image;
}
