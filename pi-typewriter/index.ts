/**
 * typewriter extension
 *
 * Some models (Opus in particular) stream fast enough that big blocks of
 * markdown can appear on screen almost all at once. For some people that
 * flickering wall-of-text is genuinely motion-sickness inducing.
 *
 * Pi's TUI has no built-in "typing speed" setting, so this fakes one: a
 * markdown transformer that reveals the (already fully-arrived) streaming
 * text roughly one character at a time, at a steady pace — a typewriter
 * effect — instead of showing however much text the provider has sent so
 * far.
 *
 * --- Why this needs more than just registerMarkdownTransformer ---
 *
 * pi only re-renders a streaming message when the underlying text CHANGES
 * (a new model delta arrives). There is no per-frame animation timer for
 * extensions. A transformer alone therefore doesn't animate between deltas
 * — it sits still, then jumps once per delta to "whatever should be visible
 * by now." To get real one-at-a-time animation, something has to force a
 * redraw on a timer, independent of when deltas arrive. The only
 * extension-facing lever that forces pi to rebuild a streaming assistant
 * message is `ctx.ui.setHiddenThinkingLabel()` — pinging it (with no
 * argument, so it never changes your configured label) makes pi rebuild
 * every assistant message including the live streaming one, which re-runs
 * this transformer. That's more expensive than a real render hook (it also
 * touches finalized messages, not just the streaming one) — there's no
 * cheaper public API for this. It only runs while there's backlog left to
 * reveal, and stops the instant the display catches up.
 *
 * --- Self-paced models: defer to the model's own streaming ---
 *
 * Some models (GLM 5.3 in particular) already pace their own output: deltas
 * arrive steadily every few tens of milliseconds, so the raw stream looks
 * like a typewriter before this extension does anything. Holding that back
 * a second time — at our slower cps, with the tick loop forcing rebuilds on
 * top of the model's own delta-driven renders — doubles the render work and
 * adds pure lag.
 *
 * So each streaming message is watched for a STEADY delta cadence: a run of
 * deltas whose inter-arrival gaps all stay small. Measured on real streams,
 * GLM 5.3 sustains multi-second runs of ~23ms gaps, while bursty models
 * (Opus) never get past tens of milliseconds before a long pause shatters
 * the run. When a run proves steady (>= MIN_RUN_DELTAS deltas spanning
 * >= DEFER_AFTER_MS), the message defers: text passes through as it
 * arrives, and the tick loop stays off. The decision is one-way for the
 * message; bursty streams never trip it, so their typewriter behavior is
 * unchanged.
 *
 * While a run is building toward that threshold, the reveal rate temporarily
 * matches the model's arrival rate (capped at BOOST_MAX_CPS, still smooth at
 * 60fps) so that flipping to deferred never dumps a pile of held-back text
 * on screen at once.
 *
 * --- Escape hatch: skip the effect for the current message ---
 *
 * Press Escape while a message is typing out to show the rest of THAT
 * message at full speed (no more waiting). It does NOT abort generation —
 * the typewriter effect resumes normally on the next assistant message/turn.
 *
 * This can't be done with pi.registerShortcut("escape", ...): any extension
 * shortcut bound to escape is checked before pi's built-in abort-on-escape
 * handling and, once matched, fully swallows the keypress — abort would
 * never fire again, for the whole session, in every context (dialogs,
 * idle chat, double-escape-to-tree, all of it). Instead this uses
 * `ctx.ui.onTerminalInput()`, a raw listener that runs before any handler
 * and can choose per-keystroke whether to consume the key. It only consumes
 * Escape when there's actual unrevealed text backlog right now; otherwise
 * it returns immediately without touching the event, so normal Escape
 * behavior (abort, cancel dialogs, double-escape, etc.) is completely
 * unaffected everywhere else.
 *
 * This extension is display-only: the real message content, session file,
 * and model context are never touched.
 *
 * Config:
 *   - Env var PI_TYPEWRITER_CPS sets the default characters/sec (default 110).
 *   - `/typewriter <cps>` changes it for the running session.
 *   - `/typewriter off` / `/typewriter on` toggles it entirely.
 *   - Escape mid-message: one-off skip for just that message (see above).
 *   - Self-paced models (GLM 5.3 in particular): automatically defers to
 *     the model's own streaming pace for that message (see above).
 *
 * Run with: pi -e ~/Projects/heron--/pi-extensions/pi-typewriter/index.ts
 * (or drop the file into ~/.pi/agent/extensions/ for global auto-load)
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

/** Characters revealed per second. 110 reads as fast, snappy typing — not sluggish. */
const DEFAULT_CPS = 110;
const MIN_CPS = 5;
const MAX_CPS = 400;

/** How often the tick loop forces a redraw while there's backlog to drain. */
const TICK_MS = 33; // ~30/sec, matches the TUI's own ~60fps render granularity well enough

/**
 * Self-paced stream detection. A steady run is a sequence of deltas whose
 * inter-arrival gaps all stay under STEADY_GAP_MAX_MS. Thresholds are
 * calibrated from real captures: GLM 5.3 sustains steady runs of 2.4-2.7s
 * across 150-200 deltas, while Opus's longest run stays at ~73ms across 13
 * deltas (its burst pauses are 300ms-2.5s and shatter the run).
 */
const STEADY_GAP_MAX_MS = 300;
const DEFER_AFTER_MS = 1200;
const MIN_RUN_DELTAS = 20;
/** Once a run looks real, reveal at the model's own pace (bounded) so the
 * flip to deferred happens with no visible dump of held-back text. A backlog
 * accumulated before the run was trusted drains over ~this many seconds. */
const BOOST_AFTER_MS = 400;
const BOOST_MAX_CPS = 700; // ~12 chars/frame at 60fps: fast but smooth
const BOOST_DRAIN_SECONDS = 0.5;

function parseCps(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.min(MAX_CPS, Math.max(MIN_CPS, n));
}

/** Mutable runtime config, adjustable via /typewriter. */
const state = {
	enabled: true,
	cps: parseCps(process.env.PI_TYPEWRITER_CPS) ?? DEFAULT_CPS,
};


/**
 * When true, the CURRENT assistant message renders at full speed regardless
 * of `state.enabled`/`state.cps`. Set by the Escape hatch; cleared on the
 * next assistant message_start, so it only ever affects "that message".
 */
let skipCurrentMessage = false;

/**
 * Per-assistant-message streaming-pace stats, used to detect models that
 * pace their own output (see "Self-paced models" in the header). Fed from
 * message_update deltas — the provider's actual arrival pattern — not from
 * transformer calls, which also fire for tick-forced redraws.
 */
interface StreamPace {
	deltasSeen: number;
	lastDeltaAt: number;
	/** Wall-time span of the current steady run (sum of its gaps). */
	runSpanMs: number;
	runDeltas: number;
	runChars: number;
	deferred: boolean;
}

function freshPace(): StreamPace {
	return { deltasSeen: 0, lastDeltaAt: performance.now(), runSpanMs: 0, runDeltas: 0, runChars: 0, deferred: false };
}

let pace = freshPace();

/**
 * Record one provider delta (text or thinking). While the current steady run
 * is still below the defer threshold this also decides whether the run
 * continues, resets, or crosses into deferred mode.
 */
function noteDelta(charCount: number, now: number): void {
	const gap = now - pace.lastDeltaAt;
	pace.lastDeltaAt = now;
	pace.deltasSeen++;
	if (pace.deferred) return;
	if (pace.deltasSeen === 1) return; // gap from message start, not between deltas
	if (gap > STEADY_GAP_MAX_MS) {
		pace.runSpanMs = 0;
		pace.runDeltas = 0;
		pace.runChars = 0;
		return;
	}
	pace.runSpanMs += gap;
	pace.runDeltas++;
	pace.runChars += charCount;
	if (pace.runDeltas >= MIN_RUN_DELTAS && pace.runSpanMs >= DEFER_AFTER_MS) {
		pace.deferred = true;
		stopTicking();
	}
}

/**
 * Reveal rate right now: the configured cps, or — while a steady run is
 * building but not yet deferred — the model's own arrival rate (bounded),
 * plus enough catch-up to drain whatever backlog piled up before the run
 * looked real, so the later flip to deferred is seamless.
 */
function effectiveCps(backlogChars: number): number {
	if (pace.runDeltas >= MIN_RUN_DELTAS && pace.runSpanMs >= BOOST_AFTER_MS) {
		const arrivalCps = pace.runChars / (pace.runSpanMs / 1000);
		let rate = Math.max(state.cps, arrivalCps);
		if (backlogChars > 0) rate = Math.max(rate, arrivalCps + backlogChars / BOOST_DRAIN_SECONDS);
		return Math.min(BOOST_MAX_CPS, rate);
	}
	return state.cps;
}

/**
 * Tracks reveal progress for one in-flight streamed block (an assistant
 * "text" section, or a run of "thinking" blocks). Keyed by matching against
 * previously seen source text rather than by message id, because
 * MarkdownTransformContext carries no id — see findOrCreate().
 *
 * `revealed` advances by whole characters only, driven by a fractional
 * `carry` accumulator, so the reveal rate stays exactly `cps` regardless of
 * how often (or unevenly) this gets called — one char at a time, not a
 * lump sum computed from elapsed time.
 */
interface RevealState {
	/** Full source markdown last seen for this block. */
	source: string;
	/** Whole characters already shown. */
	revealed: number;
	/** Fractional characters banked between calls (0..1). */
	carry: number;
	/** performance.now() of the last time this entry advanced. */
	lastTickAt: number;
}

// One list per messageType ("assistant" / "assistant-thinking"). A message
// can contain multiple non-contiguous thinking runs rendered in the same
// pass, so this isn't just a single slot.
const revealLists = new Map<string, RevealState[]>();

/** Drop all in-flight reveal state. Called at the start of each new assistant turn. */
function resetReveal(): void {
	revealLists.clear();
	skipCurrentMessage = false;
	pace = freshPace();
}

function hasBacklog(): boolean {
	for (const list of revealLists.values()) {
		for (const entry of list) {
			if (entry.revealed < entry.source.length) return true;
		}
	}
	return false;
}

/**
 * Force every in-flight "assistant-thinking" entry to fully revealed. Called
 * the moment the model moves on to text or a tool call: once that happens,
 * thinking is done for good — there is no provider that resumes thinking
 * after starting to answer or call a tool — so any remaining backlog in the
 * (now finalizing) thinking block should snap to complete instead of
 * continuing to trickle out while the model has already moved on.
 */
function completeThinkingReveal(): void {
	const list = revealLists.get("assistant-thinking");
	if (!list) return;
	for (const entry of list) entry.revealed = entry.source.length;
}

/** Length of the longest common prefix shared by two strings. */
function sharedPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i++;
	return i;
}

/**
 * A fuzzy continuation match must cover at least this fraction of whichever
 * string (old source or new markdown) is shorter. Real resegmentation keeps
 * nearly all previously streamed text intact, so this stays high — it's
 * meant to tolerate minor rewrites at the tail, not treat two blocks that
 * merely start the same way as one continuation.
 */
const CONTINUATION_OVERLAP_RATIO = 0.8;

/**
 * Absolute floor (characters) for a fuzzy continuation match, so the ratio
 * check alone can't match on a handful of coincidentally shared characters
 * when both strings are very short.
 */
const MIN_CONTINUATION_OVERLAP_FLOOR = 24;

/**
 * Find the RevealState this markdown belongs to, or create a new one when
 * `markdown` is new streaming content. Returns undefined for content that
 * was never seen while streaming (restored/static messages) — those are
 * passed through untouched, never typed out.
 *
 * Matching used to require a strict prefix relationship (old text is an
 * exact prefix of the new, or vice versa). That holds for plain
 * character-by-character streaming, but some providers (Claude's extended
 * thinking in particular) periodically RE-SEGMENT already-streamed thinking
 * text as more of the underlying reasoning arrives — a later snapshot is
 * not always a strict superstring of an earlier one, even though most of
 * the text is unchanged. A strict-prefix miss used to fall through to
 * creating a fresh entry with `revealed = 0`, discarding all reveal
 * progress and visibly restarting the typewriter effect from the top —
 * many times a second during a single thinking stream. Instead, match on
 * the longest shared prefix and clamp (never reset) `revealed` to it, so
 * genuine resegmentation keeps most of its progress instead of blanking.
 */
function findOrCreate(messageType: string, markdown: string, isStreaming: boolean): RevealState | undefined {
	let list = revealLists.get(messageType);
	if (!list) {
		list = [];
		revealLists.set(messageType, list);
	}

	// Exact match or growth of a previously seen block: keep its progress
	// (fast path — avoids the shared-prefix scan below for the common case).
	for (const entry of list) {
		if (markdown === entry.source || markdown.startsWith(entry.source) || entry.source.startsWith(markdown)) {
			entry.source = markdown;
			return entry;
		}
	}

	// Static/restored content never enters the fuzzy-match path or creates
	// entries: it must never get matched against (and corrupt) a live
	// streaming entry just because it happens to share a common opening
	// phrase ("Let me", "I need to", ...). Only isStreaming content below
	// this point can match or create.
	if (!isStreaming) return undefined;

	// No strict prefix relationship: look for a *live* entry with a long
	// shared prefix — most of both strings, not just a coincidental common
	// opener — instead of immediately treating this as a new block. Real
	// resegmentation keeps the vast majority of the previously streamed text
	// unchanged, so require the overlap to cover most of whichever string is
	// shorter, plus a floor so tiny snippets never match on ratio alone.
	let bestEntry: RevealState | undefined;
	let bestOverlap = 0;
	for (const entry of list) {
		const overlap = sharedPrefixLength(markdown, entry.source);
		const shorterLength = Math.min(markdown.length, entry.source.length);
		const required = Math.max(MIN_CONTINUATION_OVERLAP_FLOOR, Math.ceil(shorterLength * CONTINUATION_OVERLAP_RATIO));
		if (overlap >= required && overlap > bestOverlap) {
			bestOverlap = overlap;
			bestEntry = entry;
		}
	}
	if (bestEntry) {
		bestEntry.source = markdown;
		// Never let revealed exceed the text that's actually still valid at
		// this position; never reset it to 0 for a real continuation either.
		bestEntry.revealed = Math.min(bestEntry.revealed, bestOverlap, markdown.length);
		return bestEntry;
	}

	// New block (e.g. a second thinking run later in the same message).
	const entry: RevealState = { source: markdown, revealed: 0, carry: 0, lastTickAt: performance.now() };
	list.push(entry);
	// Bound growth in pathological cases (shouldn't normally exceed a couple entries).
	if (list.length > 8) list.shift();
	return entry;
}

/** Advance one entry's reveal position by real elapsed time, one character's worth of carry at a time. */
function advance(entry: RevealState, now: number, cps: number): void {
	const elapsedMs = now - entry.lastTickAt;
	entry.lastTickAt = now;
	if (elapsedMs <= 0) return;
	entry.carry += (elapsedMs / 1000) * cps;
	const wholeChars = Math.floor(entry.carry);
	if (wholeChars <= 0) return;
	entry.carry -= wholeChars;
	entry.revealed = Math.min(entry.source.length, entry.revealed + wholeChars);
}

function typewriterTransform(markdown: string, context: MarkdownTransformContext): string {
	if (!state.enabled) return markdown;
	if (skipCurrentMessage) return markdown; // Escape hatch: this message renders at full speed
	if (context.messageType === "user") return markdown;

	const entry = findOrCreate(context.messageType, markdown, context.isStreaming);
	if (!entry) return markdown; // static content

	const now = performance.now();

	// Self-paced model: show its text as it arrives and keep the reveal
	// state caught up so hasBacklog() stays false (tick loop, Escape hatch).
	if (pace.deferred) {
		entry.revealed = markdown.length;
		entry.carry = 0;
		entry.lastTickAt = now;
		return markdown;
	}

	advance(entry, now, effectiveCps(Math.max(0, markdown.length - entry.revealed)));

	if (entry.revealed <= 0) return "";
	if (entry.revealed >= markdown.length) return markdown;
	return markdown.slice(0, entry.revealed);
}

let tickInterval: ReturnType<typeof setInterval> | undefined;

function stopTicking(): void {
	if (tickInterval) {
		clearInterval(tickInterval);
		tickInterval = undefined;
	}
}

function ensureTicking(ctx: ExtensionContext): void {
	if (tickInterval || !state.enabled || !ctx.hasUI || skipCurrentMessage || pace.deferred) return;
	tickInterval = setInterval(() => {
		if (!hasBacklog()) {
			stopTicking();
			return;
		}
		ctx.ui.setHiddenThinkingLabel();
	}, TICK_MS);
}

let unsubscribeTerminalInput: (() => void) | undefined;

/**
 * Register the Escape-hatch listener once per session. Guarded so it never
 * fights with normal Escape behavior: only consumes the key when there's
 * live text backlog to skip.
 */
function setupEscapeHatch(ctx: ExtensionContext): void {
	unsubscribeTerminalInput?.();
	if (ctx.mode !== "tui") return;
	unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
		if (!matchesKey(data, Key.escape)) return undefined;
		if (!state.enabled) return undefined;
		if (skipCurrentMessage) return undefined; // already skipping: let this Escape behave normally (e.g. abort)
		if (!hasBacklog()) return undefined; // nothing typing out right now: let Escape behave normally

		skipCurrentMessage = true;
		stopTicking();
		ctx.ui.setHiddenThinkingLabel(); // force an immediate redraw so the message jumps to full text now
		ctx.ui.notify("Typewriter effect skipped for this message", "info");
		return { consume: true };
	});
}

export default function typewriterExtension(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer(typewriterTransform);

	pi.on("session_start", async (_event, ctx) => {
		setupEscapeHatch(ctx);
	});

	// New assistant turn: forget prior blocks so leftover state from a
	// previous message never bleeds into (or mis-times) a new one, and the
	// Escape-hatch skip only ever applies to the message it was pressed on.
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") resetReveal();
	});

	// Every real delta both feeds typewriterTransform directly AND is a good
	// moment to make sure the tick loop is running (idempotent if already on).
	pi.on("message_update", async (event, ctx) => {
		const eventType = event.assistantMessageEvent.type;
		if (eventType === "text_delta" || eventType === "thinking_delta") {
			noteDelta(event.assistantMessageEvent.delta.length, performance.now());
		}
		// The model has moved on to text or a tool call: thinking for this
		// message is done for good, so stop letting it lag behind at the
		// typewriter's pace and snap it to fully revealed immediately.
		if (eventType === "text_start" || eventType === "toolcall_start") completeThinkingReveal();
		ensureTicking(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTicking();
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});

	pi.registerCommand("typewriter", {
		description: "Configure the streaming-output typewriter effect",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off") {
				state.enabled = false;
				stopTicking();
				ctx.ui.notify("Typewriter effect disabled", "info");
				return;
			}
			if (arg === "on") {
				state.enabled = true;
				ctx.ui.notify(`Typewriter effect enabled (${state.cps} chars/sec)`, "info");
				return;
			}
			if (arg === "") {
				ctx.ui.notify(
					state.enabled
						? `Typewriter effect: ${state.cps} chars/sec${pace.deferred ? " (deferring to the model's own streaming pace)" : ""}`
						: "Typewriter effect: off",
					"info",
				);
				return;
			}
			const cps = parseCps(arg);
			if (!cps) {
				ctx.ui.notify(`Usage: /typewriter <chars-per-sec> | on | off (got "${args}")`, "warning");
				return;
			}
			state.cps = cps;
			state.enabled = true;
			ctx.ui.notify(`Typewriter effect set to ${cps} chars/sec`, "info");
		},
	});
}
