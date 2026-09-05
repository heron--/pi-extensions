/**
 * Shared model pricing for pi extensions.
 *
 * pi only knows a model's price when its definition carries a `cost` block.
 * Custom/gateway providers (anything defined in models.json) usually omit it,
 * and pi zero-fills the gap — so `cost` reads as $0 rather than "unknown".
 *
 * This module fills that in from @pydantic/genai-prices, a community-maintained
 * price dataset that ships bundled (no network call at render time).
 *
 * These are ESTIMATES. They're matched by model id against public list prices,
 * so they ignore your gateway's actual contract, negotiated discounts, cache
 * rates, and batch pricing. Good enough to compare models while working; not a
 * billing source. Estimated values are marked with a leading "~" by
 * formatPricing() — keep that marker in any UI you build.
 *
 * Usage:
 *   import { getPricing, formatPricing } from "../lib/pricing.ts";
 *
 *   const p = getPricing(model);   // { input, output, source } | null
 *   formatPricing(p);              // "$3/$15" | "~$3/$15" | null
 *
 * Requires `@pydantic/genai-prices` in the nearest package.json
 * `dependencies` (pi resolves node_modules from a parent directory). If it's
 * missing, estimates degrade to null rather than throwing.
 */

import { createRequire } from "node:module";

/** Where a price came from. "pi" is authoritative; "estimate" is a guess. */
export type PriceSource = "pi" | "estimate";

export interface Pricing {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
	source: PriceSource;
	/** For estimates: the dataset id that matched, useful for debugging. */
	matchedId?: string;
}

/** Minimal shape needed — avoids depending on pi's Model type here. */
export interface PriceableModel {
	id: string;
	provider?: string;
	cost?: { input?: number; output?: number } | null;
}

/**
 * Probe size for the price lookup, in tokens.
 *
 * calcPrice() returns a cost for a given usage, so we divide back out to get a
 * rate. It must stay SMALL: at 1M tokens Anthropic's >200K long-context tier
 * kicks in and sonnet-4-5 reports $6/$22.50 instead of its $3/$15 base rate.
 * 1000 tokens keeps every model in its base tier.
 */
const PROBE_TOKENS = 1000;

type CalcPrice = (
	usage: Record<string, number | undefined>,
	modelId: string,
	options?: { providerId?: string },
) => { input_price?: number; output_price?: number; model?: { id?: string } } | null;

let calcPriceFn: CalcPrice | null | undefined;

/**
 * Load genai-prices lazily and tolerate its absence.
 *
 * createRequire keeps this synchronous (render paths can't await), and the
 * try/catch means an extension still works when the dep isn't installed —
 * pricing just goes quiet instead of taking the extension down with it.
 */
function getCalcPrice(): CalcPrice | null {
	if (calcPriceFn !== undefined) return calcPriceFn;
	try {
		const require = createRequire(import.meta.url);
		const mod = require("@pydantic/genai-prices") as { calcPrice?: CalcPrice };
		calcPriceFn = typeof mod.calcPrice === "function" ? mod.calcPrice : null;
	} catch {
		calcPriceFn = null;
	}
	return calcPriceFn;
}

/**
 * Candidate ids to try against the dataset, most specific first.
 *
 * pi ids carry prefixes and suffixes the dataset doesn't use:
 *   "anthropic/claude-haiku-4-5-20251001"           → "claude-haiku-4-5"
 *   "bedrock-anthropic/us.anthropic.claude-sonnet-4-20250514-v1:0"
 *                                                   → "claude-sonnet-4"
 *   "baseten/zai-org/GLM-5.3-Flash"                 → "GLM-5.3-Flash"
 */
export function idCandidates(modelId: string): string[] {
	const out: string[] = [];
	const push = (v: string | undefined) => {
		if (v && !out.includes(v)) out.push(v);
	};

	push(modelId);
	const last = modelId.split("/").pop();
	push(last);

	let base = last ?? modelId;
	// Bedrock-style dotted ids: strip region then vendor. Guarded on a dotted
	// prefix so plain ids like "gemini-3.8-flash" are left alone (stripping
	// blindly turned that into "8-flash" and matched nothing).
	if (/^[a-z]{2,4}\./.test(base)) {
		base = base.replace(/^[a-z]{2,4}\./, "");
		base = base.replace(/^[a-z0-9-]+\./, "");
	}
	base = base.replace(/-v\d+:\d+$/, ""); // trailing "-v1:0"
	push(base);
	push(base.replace(/-\d{8}$/, "")); // trailing date stamp

	return out;
}

const estimateCache = new Map<string, Pricing | null>();

/**
 * Estimate per-Mtok pricing for a model id from the bundled dataset.
 * Returns null when nothing matches. Memoized: this runs per row, per render.
 */
export function estimatePricing(modelId: string): Pricing | null {
	const cached = estimateCache.get(modelId);
	if (cached !== undefined) return cached;

	const calcPrice = getCalcPrice();
	if (!calcPrice) {
		estimateCache.set(modelId, null);
		return null;
	}

	const usage = { input_tokens: PROBE_TOKENS, output_tokens: PROBE_TOKENS };
	let result: Pricing | null = null;

	for (const candidate of idCandidates(modelId)) {
		try {
			const r = calcPrice(usage, candidate);
			if (!r) continue;
			const input = ((r.input_price ?? 0) / PROBE_TOKENS) * 1e6;
			const output = ((r.output_price ?? 0) / PROBE_TOKENS) * 1e6;
			if (!input && !output) continue;
			result = {
				// Float division leaves artifacts like 14.999999999999998.
				input: round4(input),
				output: round4(output),
				source: "estimate",
				matchedId: r.model?.id,
			};
			break;
		} catch {
			// Unknown id / malformed entry: try the next candidate.
		}
	}

	estimateCache.set(modelId, result);
	return result;
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

/**
 * Pricing for a model: pi's own figure when it has one, otherwise an estimate.
 *
 * pi zero-fills absent cost data, so an all-zero cost is treated as "unknown"
 * and handed to the estimator rather than reported as free.
 */
export function getPricing(model: PriceableModel): Pricing | null {
	const cost = model.cost;
	const input = cost?.input ?? 0;
	const output = cost?.output ?? 0;
	if (input || output) {
		return { input, output, source: "pi" };
	}
	return estimatePricing(model.id);
}

/** Trim a rate to at most 2 decimals, dropping trailing zeros: 0.15 → "0.15". */
function trimRate(value: number): string {
	if (!Number.isFinite(value)) return "?";
	const fixed = value.toFixed(2);
	return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Render pricing as "$in/$out" per Mtok, prefixed with "~" when estimated.
 * Returns null when there is no pricing at all, so callers must decide what to
 * show rather than being handed a misleading zero.
 */
export function formatPricing(pricing: Pricing | null): string | null {
	if (!pricing) return null;
	const prefix = pricing.source === "estimate" ? "~" : "";
	return `${prefix}$${trimRate(pricing.input)}/$${trimRate(pricing.output)}`;
}
