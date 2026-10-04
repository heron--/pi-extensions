// Loads pricing.ts through jiti, as pi does, so its runtime import of pi's
// getAgentDir resolves against the live install from tsconfig.paths.json.
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, dirname, resolve } = require("node:path");
const test = require("node:test");

const paths = JSON.parse(readFileSync(resolve(__dirname, "../tsconfig.paths.json"), "utf8")).compilerOptions.paths;
const piRoot = dirname(dirname(paths["@earendil-works/pi-coding-agent"][0]));
const fromPi = createRequire(join(piRoot, "package.json"));
const { createJiti } = require(fromPi.resolve("jiti"));
const jiti = createJiti(__filename, {
	moduleCache: false,
	alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js") },
});

let findPricingOverride, formatPricing, getPricing, parsePricingOverrides, pricingOverridesGeneration, refreshPricingOverrides;
test.before(async () => {
	({
		findPricingOverride,
		formatPricing,
		getPricing,
		parsePricingOverrides,
		pricingOverridesGeneration,
		refreshPricingOverrides,
	} = await jiti.import(join(__dirname, "pricing.ts")));
});

const dir = mkdtempSync(join(tmpdir(), "pi-pricing-test-"));
const configPath = join(dir, "pi-pricing", "config.json");
mkdirSync(join(dir, "pi-pricing"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Point the config at an overrides document and load it. */
function useOverrides(document, overridesPath = "overrides.json") {
	writeFileSync(configPath, JSON.stringify({ overridesPath }));
	writeFileSync(join(dir, "pi-pricing", "overrides.json"), JSON.stringify(document));
	return refreshPricingOverrides(configPath);
}

test("parse accepts any subset of rates and rejects bad entries whole", () => {
	const { models, problems } = parsePricingOverrides({
		models: {
			"Claude-Opus-5-5": { input: 4, output: 20 },
			"only-cache": { cacheRead: 0.1 },
			typo: { input: 1, ouput: 2 },
			negative: { input: -1 },
			empty: {},
			"not-an-object": 5,
		},
	});
	assert.deepEqual([...models.keys()], ["claude-opus-5-5", "only-cache"]);
	assert.equal(problems.length, 4);
	assert.match(problems.join("\n"), /"typo": unknown field "ouput"/);
	assert.match(problems.join("\n"), /"negative": "input" must be a non-negative number/);
	assert.match(problems.join("\n"), /"empty": no rates given/);
	assert.deepEqual(parsePricingOverrides([]).problems, ['expected an object with a "models" object']);
});

test("no config, or a config without overridesPath, is silent and applies nothing", () => {
	rmSync(configPath, { force: true });
	assert.equal(refreshPricingOverrides(configPath), null);
	assert.equal(findPricingOverride("claude-opus-5"), null);
	writeFileSync(configPath, "{}");
	assert.equal(refreshPricingOverrides(configPath), null);
});

test("overrides win over pi and the dataset, per field", () => {
	assert.equal(useOverrides({ models: { "claude-opus-5-5": { input: 4, output: 20 }, "claude-opus-5": { output: 30 } } }), null);

	// Without an override this id falls to the dataset; with one it is exact.
	assert.equal(formatPricing(getPricing({ id: "anthropic/claude-opus-5-5" })), "$4/$20");
	assert.equal(getPricing({ id: "anthropic/claude-opus-5-5" }).source, "override");

	// A partial override wins over pi's figure for the field it sets only.
	const piPriced = getPricing({ id: "claude-opus-5", cost: { input: 5, output: 25 } });
	assert.deepEqual([piPriced.input, piPriced.output, piPriced.source], [5, 30, "pi"]);

	// ...and over the dataset, which keeps the estimate marker.
	assert.equal(formatPricing(getPricing({ id: "anthropic/claude-opus-5" })), "~$5/$30");

	// Unrelated models are untouched.
	assert.equal(formatPricing(getPricing({ id: "claude-sonnet-5" })), "~$2/$10");
	assert.equal(formatPricing(getPricing({ id: "x", cost: { input: 1, output: 2 } })), "$1/$2");
});

test("keys match provider/id first, then stripped id forms, case-insensitively, never by prefix", () => {
	useOverrides({
		models: {
			"ai-gw/anthropic/claude-opus-5": { input: 1, output: 1 },
			"CLAUDE-OPUS-5": { input: 2, output: 2 },
		},
	});
	assert.equal(findPricingOverride("anthropic/claude-opus-5", "ai-gw").key, "ai-gw/anthropic/claude-opus-5");
	assert.equal(findPricingOverride("anthropic/claude-opus-5", "other").key, "CLAUDE-OPUS-5");
	assert.equal(findPricingOverride("bedrock/us.anthropic.claude-opus-5-v1:0").key, "CLAUDE-OPUS-5");
	assert.equal(findPricingOverride("claude-opus-5-5"), null);
});

test("a model unknown to the dataset shows a missing rate as unknown", () => {
	useOverrides({ models: { "private-model": { output: 8 } } });
	assert.equal(formatPricing(getPricing({ id: "private-model" })), "$?/$8");
});

test("problems are reported once, bad entries are skipped, and good ones still apply", () => {
	const problem = useOverrides({ models: { good: { input: 1, output: 2 }, bad: { input: "1" } } });
	assert.match(problem, /overrides\.json: "bad": "input" must be a non-negative number/);
	assert.equal(refreshPricingOverrides(configPath), null);
	assert.equal(formatPricing(getPricing({ id: "good" })), "$1/$2");

	writeFileSync(configPath, JSON.stringify({ overridesPath: "missing.json" }));
	assert.match(refreshPricingOverrides(configPath), /Could not read pricing overrides .*missing\.json/);
	assert.equal(findPricingOverride("good"), null);

	writeFileSync(configPath, "{");
	assert.match(refreshPricingOverrides(configPath), /Could not parse .*config\.json/);
});

test("the generation changes only when the loaded files do", () => {
	useOverrides({ models: { a: { input: 1 } } });
	const generation = pricingOverridesGeneration();
	refreshPricingOverrides(configPath);
	assert.equal(pricingOverridesGeneration(), generation);
	useOverrides({ models: { a: { input: 2 } } });
	assert.equal(pricingOverridesGeneration(), generation + 1);
	assert.equal(getPricing({ id: "a" }).input, 2);
});

test("overridesPath expands ~ and resolves relative to the config directory", () => {
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ models: { z: { input: 3, output: 3 } } }));
	writeFileSync(configPath, JSON.stringify({ overridesPath: "../elsewhere.json" }));
	assert.equal(refreshPricingOverrides(configPath), null);
	assert.equal(findPricingOverride("z").key, "z");
	writeFileSync(configPath, JSON.stringify({ overridesPath: "~/definitely-not-here-pi-pricing.json" }));
	assert.doesNotMatch(refreshPricingOverrides(configPath), /~/);
});
