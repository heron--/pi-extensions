// Resolve Pi runtime imports against the same live install as the typechecker.
// Run sync-pi-types.mjs first; no second Pi version is installed into this repo.
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const paths = JSON.parse(readFileSync(new URL("../tsconfig.paths.json", import.meta.url), "utf8")).compilerOptions.paths;
const fromPi = createRequire(paths["@earendil-works/pi-coding-agent"][0]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@earendil-works/pi-")) {
			return { url: pathToFileURL(fromPi.resolve(specifier)).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
