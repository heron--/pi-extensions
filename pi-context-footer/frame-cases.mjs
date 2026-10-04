// Characterization cases for the frame and plain mode. The expected screens in
// fixtures/frame.json were first captured from the footer as it was before
// the layout became configurable, so the default layout must reproduce them.
import { setTimeout as delay } from "node:timers/promises";
import { writeLockStatusText } from "../pi-write-lock/index.ts";

const IDENTITY = { hostname: { match: ".", nickname: "box" } };
const STATUSES = {
	"background-tasks": "\x1b[44m 2 tasks \x1b[0m",
	// As pi-write-lock publishes it: styled for pi's own footer, icon included.
	"write-lock": `\x1b[2m${writeLockStatusText(false)}\x1b[22m`,
	"unrelated-status": "should not show",
};
const FULL = { sessionName: "naming things", config: IDENTITY, statuses: STATUSES };

export const FRAME_CASES = [
	{ name: "bare-120", width: 120, options: {} },
	...[120, 80, 40, 26, 24].map((width) => ({ name: `full-${width}`, width, options: FULL })),
	{ name: "plain-23", width: 23, options: FULL, footer: true },
	{ name: "plain-12", width: 12, options: FULL, footer: true },
	{ name: "long-session-name-40", width: 40, options: { ...FULL, sessionName: "a session name far too long for the rule" } },
	{ name: "no-branch-80", width: 80, options: { ...FULL, branch: null } },
	{ name: "thinking-off-80", width: 80, options: { ...FULL, thinkingLevel: "off" } },
	{ name: "no-reasoning-80", width: 80, options: { ...FULL, model: { id: "plain-model", name: "Plain", reasoning: false, contextWindow: 8000 } } },
	{ name: "multiline-80", width: 80, options: { ...FULL, input: "first line\nsecond line\nthird line" } },
	{
		name: "completions-80",
		width: 80,
		options: FULL,
		setup: (host) => {
			host.state.completions = ["  /model   switch model", "  /new     new session"];
		},
	},
	{
		name: "scrolled-80",
		width: 80,
		options: FULL,
		setup: (host) => {
			host.state.scrolledAbove = "↑ 3 more";
			host.state.scrolledBelow = "↓ 2 more";
		},
	},
	{
		name: "scrolled-completions-80",
		width: 80,
		options: FULL,
		setup: (host) => {
			host.state.scrolledBelow = "↓ 2 more";
			host.state.completions = ["  /model   switch model"];
		},
	},
	{ name: "pad-none-80", width: 80, options: FULL, setup: (host) => host.command("pad none") },
	{
		name: "pull-request-120",
		width: 120,
		options: { ...FULL, pullRequest: { number: 4, url: "https://example.com/pull/4" } },
		setup: async (host) => {
			for (let tries = 0; tries < 100 && host.state.renderRequests === 0; tries++) await delay(20);
		},
	},
];
