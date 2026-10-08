import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * pi's agent directory: `PI_CODING_AGENT_DIR` when set, expanded the way pi
 * expands it (`~` and a leading `~/`), else `~/.pi/agent`. pi loads global
 * extensions from its `extensions/` subdirectory, and the extensions here keep
 * their settings in `<agent dir>/<extension>/config.json`.
 */
export function agentDirectory(env = process.env, home = homedir()) {
	const configured = env.PI_CODING_AGENT_DIR;
	if (!configured) return join(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/")) return join(home, configured.slice(2));
	return resolve(configured);
}

/** `path` for display, with the home directory shortened to `~`. */
export function displayPath(path, home = homedir()) {
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
