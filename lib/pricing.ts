/**
 * Shared model pricing for pi extensions.
 *
 * Rates come from three places, and each rate field resolves independently in
 * this order:
 *
 *   1. a local override file (see "Overrides" below) — the user's own prices
 *   2. pi's figure — the model definition's `cost` block, or the cost pi
 *      recorded on a response
 *   3. an estimate from @pydantic/genai-prices, a community-maintained public
 *      list-price dataset that ships bundled (no network call at render time)
 *
 * pi zero-fills `cost` when a definition omits it (custom/gateway providers in
 * models.json usually do), so an all-zero pi cost is "unknown", not "free", and
 * falls through to the dataset.
 *
 * Estimates ignore gateway contracts, negotiated discounts, and batch pricing.
 * formatPricing() marks any figure that used one with a leading "~" — keep that
 * marker in any UI you build.
 *
 * Overrides: `<agent dir>/pi-pricing/config.json` may name an overrides file,
 *
 *   { "overridesPath": "~/private/pi-price-overrides.json" }
 *
 * which maps model ids to USD-per-million-token rates. Any subset of fields
 * may be given; the rest resolve from pi or the dataset.
 *
 *   { "models": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 } } }
 *
 * Usage:
 *   import { getPricing, formatPricing, usageCost } from "../lib/pricing.ts";
 *
 *   const p = getPricing(model);   // { input, output, source } | null
 *   formatPricing(p);              // "$3/$15" | "~$3/$15" | null
 *   usageCost(id, usage, provider) // { total, source } | null
 *
 * Requires `@pydantic/genai-prices` in the nearest package.json
 * `dependencies` (pi resolves node_modules from a parent directory). If it's
 * missing, estimates degrade to null rather than throwing.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a price came from: "override" is the user's own figure, "pi" is pi's,
 * "estimate" is a public list-price guess. A figure assembled from several
 * sources reports the least certain of them, with "estimate" least certain.
 */
export type PriceSource = "override" | "pi" | "estimate";

export interface Pricing {
	/** USD per million input tokens. NaN when no source has an input rate. */
	input: number;
	/** USD per million output tokens. NaN when no source has an output rate. */
	output: number;
	source: PriceSource;
	/** The dataset id an estimate matched, useful for debugging. */
	matchedId?: string;
	/** The override-file key that matched, useful for debugging. */
	overrideKey?: string;
}

/** Minimal shape needed — avoids depending on pi's Model type here. */
export interface PriceableModel {
	id: string;
	provider?: string;
	cost?: { input?: number; output?: number } | null;
}

/** Per-million-token rates an override may set. */
export interface RateOverride {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type RateField = (typeof RATE_FIELDS)[number];
type Rates = Record<RateField, number>;

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
) => {
	input_price?: number;
	output_price?: number;
	total_price?: number;
	model?: { id?: string };
} | null;

/** Usage fields pi records for one completed assistant response. */
export interface PriceableUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Usage plus the cost pi recorded for it, which is all-zero when pi had no price. */
export interface RecordedUsage extends PriceableUsage {
	cost: Rates & { total: number };
}

export interface UsageCostEstimate {
	total: number;
	matchedId: string;
}

export interface UsageCost {
	/** USD for the response. */
	total: number;
	source: PriceSource;
}

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
		// Extensions can be discovered through ~/.pi symlinks. Resolve the real
		// shared-library path first so Node can find this repository's dependency.
		const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
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
 *   "databricks/databricks-glm-5-3-flash"           → "glm-5.3-flash"
 *   "databricks/system.ai.kimi-k3"                  → "kimi-k3"
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

	// Databricks-hosted copies rename the models they serve: dots in the
	// version become hyphens (glm-5-3-flash), a `databricks-` prefix or a
	// dotted vendor namespace may lead the name (system.ai.kimi-k3), and one
	// listing carries a -pt suffix (glm-5-3-pt). Strip those, then put the
	// dots back between digits. These candidates come last, so an id that
	// already matched keeps its match, and the digit-dot rewrite only ever
	// fires on ids the earlier candidates could not price.
	let hosted = base;
	hosted = hosted.replace(/^databricks-/, "");
	// Leading dotted labels of lowercase letters only: a vendor namespace
	// (system.ai.), never a versioned model name (gemini-3.8-flash — the
	// "gemini-3" label carries a digit, so it does not match).
	hosted = hosted.replace(/^(?:[a-z]+\.)+/, "");
	hosted = hosted.replace(/-pt$/, "");
	push(hosted);
	push(hosted.replace(/(\d)-(\d)/g, "$1.$2"));

	return out;
}

// ---------------------------------------------------------------------------
// Dataset rates
// ---------------------------------------------------------------------------

interface DatasetRates extends Rates {
	matchedId?: string;
}

const datasetCache = new Map<string, DatasetRates | null>();

/**
 * Flat per-million-token base rates for a model id from the bundled dataset,
 * or null when nothing matches. Memoized: this runs per row, per render.
 *
 * Cache rates are probed with all input tokens marked as cache reads (or
 * writes). A model the dataset lists without a cache price reports its input
 * rate for that probe, so the fallback matches what calcPrice itself charges.
 */
function datasetRates(modelId: string): DatasetRates | null {
	const cached = datasetCache.get(modelId);
	if (cached !== undefined) return cached;

	const calcPrice = getCalcPrice();
	let result: DatasetRates | null = null;
	for (const candidate of calcPrice ? idCandidates(modelId) : []) {
		try {
			const r = calcPrice!({ input_tokens: PROBE_TOKENS, output_tokens: PROBE_TOKENS }, candidate);
			if (!r) continue;
			const input = toRate(r.input_price);
			const output = toRate(r.output_price);
			if (!input && !output) continue;
			const cacheRate = (field: "cache_read_tokens" | "cache_write_tokens"): number => {
				try {
					const probe = calcPrice!({ input_tokens: PROBE_TOKENS, [field]: PROBE_TOKENS }, candidate);
					return probe ? toRate(probe.input_price) : input;
				} catch {
					return input;
				}
			};
			result = {
				input,
				output,
				cacheRead: cacheRate("cache_read_tokens"),
				cacheWrite: cacheRate("cache_write_tokens"),
				matchedId: r.model?.id,
			};
			break;
		} catch {
			// Unknown id / malformed entry: try the next candidate.
		}
	}

	datasetCache.set(modelId, result);
	return result;
}

function toRate(price: number | undefined): number {
	// Float division leaves artifacts like 14.999999999999998.
	return round4(((price ?? 0) / PROBE_TOKENS) * 1e6);
}

/** Estimate per-Mtok input/output pricing for a model id from the bundled dataset alone. */
export function estimatePricing(modelId: string): Pricing | null {
	const rates = datasetRates(modelId);
	if (!rates) return null;
	return { input: rates.input, output: rates.output, source: "estimate", matchedId: rates.matchedId };
}

/**
 * Estimate one response from the bundled dataset alone.
 *
 * pi stores uncached input separately from cache reads and writes. The price
 * calculator expects `input_tokens` to include all three, then applies cache
 * rates to the corresponding portions. Calls must stay per response because
 * long-context price tiers apply per request, not per session.
 */
export function estimateUsageCost(modelId: string, usage: PriceableUsage): UsageCostEstimate | null {
	const calcPrice = getCalcPrice();
	if (!calcPrice) return null;

	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (!inputTokens && !usage.output) return { total: 0, matchedId: modelId };

	for (const candidate of idCandidates(modelId)) {
		try {
			const result = calcPrice({
				input_tokens: inputTokens,
				output_tokens: usage.output,
				cache_read_tokens: usage.cacheRead,
				cache_write_tokens: usage.cacheWrite,
			}, candidate);
			if (typeof result?.total_price !== "number" || !Number.isFinite(result.total_price)) continue;
			return { total: result.total_price, matchedId: result.model?.id ?? candidate };
		} catch {
			// An unknown model or an unsupported usage shape tries the next id.
		}
	}
	return null;
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Loaded override state, kept on globalThis because each extension that imports
 * this file may get its own module instance. Sharing it means one broken
 * override file is reported once, not once per extension.
 */
interface OverrideState {
	/** Config path + file contents last loaded; unchanged means nothing to reload. */
	signature?: string;
	/** Bumped whenever the loaded overrides change, for callers' caches. */
	generation: number;
	/** Lower-cased model key → rates. */
	models: Map<string, { key: string; rates: RateOverride }>;
	/** Why the configured overrides could not be fully loaded, if they could not. */
	problem: string | null;
	/** The problem last handed to a caller for display. */
	reportedProblem: string | null;
	/** `provider\0modelId` → matched override, for the current generation. */
	lookups: Map<string, { key: string; rates: RateOverride } | null>;
}

const STATE_KEY = Symbol.for("pi-extensions.pricing-overrides");

function state(): OverrideState {
	const holder = globalThis as { [STATE_KEY]?: OverrideState };
	holder[STATE_KEY] ??= {
		generation: 0,
		models: new Map(),
		problem: null,
		reportedProblem: null,
		lookups: new Map(),
	};
	return holder[STATE_KEY];
}

/**
 * The pricing config file. It lives in pi's agent-config directory (so
 * PI_CODING_AGENT_DIR is respected) and not under `<agent dir>/extensions/`,
 * which resolves into this git checkout through the install symlinks.
 */
export function pricingConfigPath(): string {
	return join(getAgentDir(), "pi-pricing", "config.json");
}

/** Expand a leading `~` and resolve a relative path against `baseDir`. */
function expandPath(path: string, baseDir: string): string {
	return resolve(baseDir, path.replace(/^~(?=$|[\\/])/, homedir()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Validate an overrides document. Entries with any invalid field are dropped
 * whole rather than applied partly, and every rejection is listed in
 * `problems`, so a typo cannot silently fall back to the dataset's price.
 */
export function parsePricingOverrides(value: unknown): {
	models: Map<string, { key: string; rates: RateOverride }>;
	problems: string[];
} {
	const models = new Map<string, { key: string; rates: RateOverride }>();
	const problems: string[] = [];
	if (!isRecord(value) || !isRecord(value.models)) {
		problems.push('expected an object with a "models" object');
		return { models, problems };
	}
	for (const [rawKey, rawRates] of Object.entries(value.models)) {
		const key = rawKey.trim();
		if (!key || !isRecord(rawRates)) {
			problems.push(`"${rawKey}": expected an object of rates`);
			continue;
		}
		const rates: RateOverride = {};
		const bad: string[] = [];
		for (const [field, rate] of Object.entries(rawRates)) {
			if (!(RATE_FIELDS as readonly string[]).includes(field)) {
				bad.push(`unknown field "${field}"`);
			} else if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
				bad.push(`"${field}" must be a non-negative number`);
			} else {
				rates[field as RateField] = rate;
			}
		}
		if (!bad.length && !Object.keys(rates).length) bad.push("no rates given");
		if (models.has(key.toLowerCase())) bad.push("duplicate model id");
		if (bad.length) {
			problems.push(`"${key}": ${bad.join(", ")}`);
			continue;
		}
		models.set(key.toLowerCase(), { key, rates });
	}
	return { models, problems };
}

interface LoadedOverrides {
	signature: string;
	models: Map<string, { key: string; rates: RateOverride }>;
	problem: string | null;
}

function loadOverrides(configPath: string): LoadedOverrides {
	const none = new Map<string, { key: string; rates: RateOverride }>();
	let configText: string;
	try {
		configText = readFileSync(configPath, "utf8");
	} catch (error) {
		if (isMissing(error)) return { signature: `${configPath}\0`, models: none, problem: null };
		return { signature: `${configPath}\0!`, models: none, problem: `Could not read ${configPath}: ${describe(error)}` };
	}

	const signature = [configPath, configText];
	const fail = (problem: string): LoadedOverrides => ({ signature: signature.join("\0"), models: none, problem });

	let overridesPath: unknown;
	try {
		const config = JSON.parse(configText) as unknown;
		if (!isRecord(config)) return fail(`${configPath}: expected a JSON object`);
		overridesPath = config.overridesPath;
	} catch (error) {
		return fail(`Could not parse ${configPath}: ${describe(error)}`);
	}
	if (overridesPath === undefined || overridesPath === null || overridesPath === "") {
		return { signature: signature.join("\0"), models: none, problem: null };
	}
	if (typeof overridesPath !== "string") return fail(`${configPath}: "overridesPath" must be a string`);

	const path = expandPath(overridesPath, dirname(configPath));
	signature.push(path);
	let overridesText: string;
	try {
		overridesText = readFileSync(path, "utf8");
	} catch (error) {
		return fail(`Could not read pricing overrides ${path}: ${describe(error)}`);
	}
	signature.push(overridesText);

	let parsed: ReturnType<typeof parsePricingOverrides>;
	try {
		parsed = parsePricingOverrides(JSON.parse(overridesText) as unknown);
	} catch (error) {
		return fail(`Could not parse pricing overrides ${path}: ${describe(error)}`);
	}
	return {
		signature: signature.join("\0"),
		models: parsed.models,
		problem: parsed.problems.length ? `Pricing overrides ${path}: ${parsed.problems.join("; ")}` : null,
	};
}

/**
 * Re-read the pricing config and overrides file, applying any change.
 *
 * Returns a problem message the caller should show the user, or null. A given
 * problem is returned once, so several extensions refreshing at session start
 * produce one notification; it is returned again after it clears and recurs.
 */
export function refreshPricingOverrides(configPath = pricingConfigPath()): string | null {
	const current = state();
	const loaded = loadOverrides(configPath);
	if (loaded.signature !== current.signature) {
		current.signature = loaded.signature;
		current.models = loaded.models;
		current.problem = loaded.problem;
		current.lookups.clear();
		current.generation++;
	}
	if (current.problem === null) {
		current.reportedProblem = null;
		return null;
	}
	if (current.problem === current.reportedProblem) return null;
	current.reportedProblem = current.problem;
	return current.problem;
}

/** Changes whenever the loaded overrides do; for caching computed costs. */
export function pricingOverridesGeneration(): number {
	const current = state();
	if (current.signature === undefined) refreshPricingOverrides();
	return current.generation;
}

/**
 * The override for a model, if the overrides file has one.
 *
 * Keys match case-insensitively against `provider/id` and then the same
 * progressively-stripped id forms the dataset lookup uses, so a key may be as
 * specific as `ai-gw/anthropic/claude-opus-5-5` or as general as
 * `claude-opus-5-5`. Matching is exact per form: no prefix or fuzzy match.
 */
export function findPricingOverride(
	modelId: string,
	provider?: string,
): { key: string; rates: RateOverride } | null {
	const current = state();
	if (current.signature === undefined) refreshPricingOverrides();
	if (!current.models.size) return null;

	const lookupKey = `${provider ?? ""}\0${modelId}`;
	const cached = current.lookups.get(lookupKey);
	if (cached !== undefined) return cached;

	const candidates = [...(provider ? [`${provider}/${modelId}`] : []), ...idCandidates(modelId)];
	let match: { key: string; rates: RateOverride } | null = null;
	for (const candidate of candidates) {
		const found = current.models.get(candidate.toLowerCase());
		if (found) {
			match = found;
			break;
		}
	}
	current.lookups.set(lookupKey, match);
	return match;
}

// ---------------------------------------------------------------------------
// Merged pricing
// ---------------------------------------------------------------------------

const UNCERTAINTY: Record<PriceSource, number> = { override: 0, pi: 1, estimate: 2 };

function leastCertain(sources: Iterable<PriceSource>): PriceSource | null {
	let worst: PriceSource | null = null;
	for (const source of sources) {
		if (worst === null || UNCERTAINTY[source] > UNCERTAINTY[worst]) worst = source;
	}
	return worst;
}

/**
 * Per-Mtok input/output pricing for a model.
 *
 * Each rate is the override's when it sets one, else pi's (an all-zero pi cost
 * counts as absent, since pi zero-fills), else the dataset's. A rate with no
 * source at all is NaN, which formatPricing() shows as "?". Null means no
 * source knows either rate.
 */
export function getPricing(model: PriceableModel): Pricing | null {
	const override = findPricingOverride(model.id, model.provider);
	const piInput = model.cost?.input ?? 0;
	const piOutput = model.cost?.output ?? 0;
	const hasPi = Boolean(piInput || piOutput);

	if (!override) {
		if (hasPi) return { input: piInput, output: piOutput, source: "pi" };
		return estimatePricing(model.id);
	}

	const dataset = hasPi ? null : datasetRates(model.id);
	const sources: PriceSource[] = [];
	const rate = (field: "input" | "output", piRate: number): number => {
		const own = override.rates[field];
		if (own !== undefined) {
			sources.push("override");
			return own;
		}
		if (hasPi) {
			sources.push("pi");
			return piRate;
		}
		if (dataset) {
			sources.push("estimate");
			return dataset[field];
		}
		return Number.NaN;
	};
	const input = rate("input", piInput);
	const output = rate("output", piOutput);
	const source = leastCertain(sources);
	if (source === null) return null;
	return {
		input,
		output,
		source,
		overrideKey: override.key,
		...(dataset && source === "estimate" ? { matchedId: dataset.matchedId } : {}),
	};
}

/**
 * Cost of one response.
 *
 * Without an override this is pi's recorded cost when it has one, else a
 * tier-aware dataset estimate. With an override, each of input, output,
 * cache-read, and cache-write is charged at the override's rate when it sets
 * one, else at pi's recorded cost for that part, else at the dataset's flat
 * base rate; a cache rate no source knows is charged at the resolved input
 * rate, as the dataset itself does for models it lists without cache prices.
 * Override rates are flat, so long-context tiers do not apply to responses an
 * override covers. Null means the response cannot be priced.
 */
export function usageCost(modelId: string, usage: RecordedUsage, provider?: string): UsageCost | null {
	const recorded = usage.cost.total > 0;
	const override = findPricingOverride(modelId, provider);
	if (!override) {
		if (recorded) return { total: usage.cost.total, source: "pi" };
		const estimate = estimateUsageCost(modelId, usage);
		return estimate ? { total: estimate.total, source: "estimate" } : null;
	}

	const dataset = recorded ? null : datasetRates(modelId);
	const sources: PriceSource[] = [];
	const part = (field: RateField, inputRate?: number): number | null => {
		const tokens = usage[field];
		if (!tokens) return 0;
		const own = override.rates[field];
		if (own !== undefined) {
			sources.push("override");
			return (tokens * own) / 1e6;
		}
		if (recorded) {
			sources.push("pi");
			return usage.cost[field];
		}
		if (dataset) {
			sources.push("estimate");
			return (tokens * dataset[field]) / 1e6;
		}
		if (inputRate !== undefined) {
			sources.push("override");
			return (tokens * inputRate) / 1e6;
		}
		return null;
	};

	const input = part("input");
	const output = part("output");
	const inputRate = override.rates.input;
	const cacheRead = part("cacheRead", inputRate);
	const cacheWrite = part("cacheWrite", inputRate);
	if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
	return {
		total: input + output + cacheRead + cacheWrite,
		source: leastCertain(sources) ?? "override",
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Trim a rate to at most 2 decimals, dropping trailing zeros: 0.15 → "0.15". */
function trimRate(value: number): string {
	if (!Number.isFinite(value)) return "?";
	const fixed = value.toFixed(2);
	return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Render pricing as "$in/$out" per Mtok, prefixed with "~" when any part is
 * estimated. Returns null when there is no pricing at all, so callers must
 * decide what to show rather than being handed a misleading zero.
 */
export function formatPricing(pricing: Pricing | null): string | null {
	if (!pricing) return null;
	const prefix = pricing.source === "estimate" ? "~" : "";
	return `${prefix}$${trimRate(pricing.input)}/$${trimRate(pricing.output)}`;
}

/**
 * Refresh the overrides at session start and surface a load problem as a pi
 * notification. Every extension that shows pricing calls this; the shared
 * state makes the notification appear once.
 */
export function refreshPricingOverridesForSession(ctx: {
	hasUI: boolean;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): void {
	const problem = refreshPricingOverrides();
	if (problem && ctx.hasUI) ctx.ui.notify(problem, "warning");
}
