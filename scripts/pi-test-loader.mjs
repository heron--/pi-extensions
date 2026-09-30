// Resolve Pi runtime imports against the same live install as the typechecker.
// Run sync-pi-types.mjs first; no second Pi version is installed into this repo.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const paths = JSON.parse(readFileSync(new URL("../tsconfig.paths.json", import.meta.url), "utf8")).compilerOptions.paths;
const piEntry = pathToFileURL(paths["@earendil-works/pi-coding-agent"][0]).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@earendil-works/pi-")) {
			// Preserve ESM's import condition for packages with import-only exports.
			return nextResolve(specifier, { ...context, parentURL: piEntry });
		}
		return nextResolve(specifier, context);
	},
});
