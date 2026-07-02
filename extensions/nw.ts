/**
 * /nw ("next window") — defer a demanding prompt until the current usage
 * sub-window rolls over.
 *
 * Motivation: subscription providers (e.g. Anthropic) meter usage in a rolling
 * 5-hour window. When you want to run something heavy overnight but the current
 * window is already partly spent, firing it now risks overrunning the window.
 * `/nw <prompt>` looks at the current provider's short rolling window (via the
 * sub-core extension), waits until that window resets (+ a safety margin), then
 * submits <prompt> as a normal user turn — so demanding work naturally spreads
 * across fresh windows.
 *
 * Usage:
 *   /nw <prompt>     schedule <prompt> to run once the current window resets
 *   /nw              show the pending job (or help), does not schedule
 *   /nw cancel       cancel the pending job
 *
 * Data source: the sub-core extension (@marckrenn/pi-sub-core) via its event
 * bus. We ask sub-core which provider is current (it maps the active model to a
 * provider name itself, e.g. openai-codex -> codex) and read that provider's
 * usage windows from sub-core's cache; on a cache miss we do one forced fetch.
 * We then pick the window that resets soonest (the short rolling window, "5h"
 * on Anthropic) and schedule off its `resetAt` timestamp.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Safety margin past the reported reset time — reset clocks can be slightly off
// and we never want to fire while the old window is technically still live.
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const WIDGET_KEY = "nw";
// Cached reads reply synchronously; a forced fetch hits the network for the
// provider, so give it a longer budget.
const CORE_TIMEOUT_MS = 3000;
const CORE_FORCE_TIMEOUT_MS = 15000;
// setTimeout delays above 2^31-1 ms overflow and fire almost immediately, so
// long waits (e.g. monthly windows) must be chunked below this.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}
interface UsageSnapshot {
	provider: string;
	displayName?: string;
	windows: RateWindow[];
}
interface ProviderUsageEntry {
	provider: string;
	usage?: UsageSnapshot;
}

// --- sub-core event-bus requests ------------------------------------------

interface CurrentState {
	provider?: string;
	usage?: UsageSnapshot;
}

// The current provider + its usage snapshot, straight from sub-core's live
// state (`lastState`) for the current model's provider. Crucially this is the
// SAME source the status bar renders, and it is NOT subject to the entries
// endpoint's ~60s cache TTL, which drops entries whose last fetch is stale
// (common during long turns). So `usage.windows` here carries `resetAt`
// whenever the bar shows a reset time.
function requestCurrentState(pi: ExtensionAPI): Promise<CurrentState | undefined> {
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				resolve(undefined);
			}
		}, CORE_TIMEOUT_MS);
		pi.events.emit("sub-core:request", {
			type: "current",
			reply: (payload: { state?: CurrentState }) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(payload?.state);
			},
		});
	});
}

// Force sub-core to fetch, then return fresh entries. Used only as a cold-cache
// fallback when the live current-state has no window with a reset time yet.
function requestEntries(pi: ExtensionAPI, force = false): Promise<ProviderUsageEntry[] | undefined> {
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				resolve(undefined);
			}
		}, force ? CORE_FORCE_TIMEOUT_MS : CORE_TIMEOUT_MS);
		pi.events.emit("sub-core:request", {
			type: "entries",
			force,
			reply: (payload: { entries?: ProviderUsageEntry[] }) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(payload?.entries);
			},
		});
	});
}

/**
 * Schedule `cb` to run at absolute time `fireAt` (epoch ms), safe for delays
 * beyond setTimeout's ~24.8-day ceiling by re-arming in <=MAX_TIMEOUT_MS chunks.
 * Returns a cancel function.
 */
export function scheduleAt(fireAt: number, cb: () => void, now = () => Date.now()): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = () => {
		const remaining = fireAt - now();
		if (remaining <= 0) {
			cb();
			return;
		}
		timer = setTimeout(tick, Math.min(remaining, MAX_TIMEOUT_MS));
		timer.unref?.();
	};
	tick();
	return () => {
		if (timer) clearTimeout(timer);
	};
}

// --- window selection ------------------------------------------------------

/**
 * Pick the window that governs when it's safe to resume: among the provider's
 * windows that carry a future `resetAt`, the one that resets soonest — i.e. the
 * short rolling window (Anthropic "5h"). Returns undefined if none qualifies.
 */
export function pickNextResetWindow(
	windows: RateWindow[] | undefined,
	now = Date.now(),
): RateWindow | undefined {
	if (!windows?.length) return undefined;
	let best: RateWindow | undefined;
	let bestTime = Infinity;
	for (const w of windows) {
		if (!w.resetAt) continue;
		const t = Date.parse(w.resetAt);
		if (Number.isNaN(t) || t <= now) continue;
		if (t < bestTime) {
			bestTime = t;
			best = w;
		}
	}
	return best;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "0m";
	const totalMin = Math.round(ms / 60000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function formatClock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Render the prompt for a notification. Deliberately does NOT truncate: `/nw`
 * runs this prompt unattended hours later, so the confirmation/status line is
 * the user's one chance to verify exactly what they scheduled. Cutting it off
 * anywhere would hide part of that commitment. We only collapse whitespace so
 * it fits on a notification line.
 */
export function preview(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	interface Pending {
		prompt: string;
		fireAt: number;
		cancelTimer: () => void;
		ticker: ReturnType<typeof setInterval>;
		provider: string;
		windowLabel: string;
		// Raw model.provider string at schedule time, to detect a provider switch
		// (compared against model_select events, which use the same raw strings).
		modelProvider?: string;
	}
	let pending: Pending | undefined;

	function clearWidget(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	function renderWidget(ctx: ExtensionContext) {
		if (!pending || !ctx.hasUI) return;
		const remaining = pending.fireAt - Date.now();
		const where = pending.provider ? ` (${pending.provider} ${pending.windowLabel ?? "window"})` : "";
		ctx.ui.setWidget(
			WIDGET_KEY,
			[`⏳ /nw${where}: resuming in ${formatDuration(remaining)} at ${formatClock(pending.fireAt)}`],
			{ placement: "aboveEditor" },
		);
	}

	function cancelPending(ctx: ExtensionContext, notify = true): boolean {
		if (!pending) return false;
		pending.cancelTimer();
		clearInterval(pending.ticker);
		pending = undefined;
		clearWidget(ctx);
		if (notify && ctx.hasUI) ctx.ui.notify("/nw: cancelled pending job", "info");
		return true;
	}

	pi.registerCommand("nw", {
		description: "Defer a prompt until the current usage window resets (+5m). Usage: /nw <prompt> | /nw cancel",
		handler: async (args, ctx) => {
			const text = args.trim();

			// Bare /nw or /nw cancel: manage the existing job, never schedule.
			if (!text || text.toLowerCase() === "cancel") {
				if (text.toLowerCase() === "cancel") {
					if (!cancelPending(ctx)) ctx.ui.notify("/nw: nothing scheduled", "info");
					return;
				}
				if (pending) {
					const remaining = pending.fireAt - Date.now();
					ctx.ui.notify(
						`/nw: resuming in ${formatDuration(remaining)} (at ${formatClock(pending.fireAt)}) — "${preview(pending.prompt)}". /nw cancel to abort.`,
						"info",
					);
				} else {
					ctx.ui.notify("/nw <prompt> — run <prompt> once the current usage window resets (+5m)", "info");
				}
				return;
			}

			// Ask sub-core for the current provider + its live usage snapshot. This is
			// the same source the status bar renders (sub-core maps the active model to
			// a provider name itself, e.g. openai-codex -> codex) and, unlike the
			// entries endpoint, it is not dropped by a ~60s cache TTL.
			const state = await requestCurrentState(pi);
			const provider = state?.provider;
			if (!provider) {
				ctx.ui.notify(
					"/nw: couldn't determine the current provider from sub-core (is the sub extension loaded and this provider tracked?)",
					"error",
				);
				return;
			}

			// Prefer the live snapshot's windows; on a cold miss (no reset time yet),
			// force one fetch for this provider before giving up.
			let win = pickNextResetWindow(state.usage?.windows);
			if (!win?.resetAt) {
				const entries = await requestEntries(pi, true);
				win = pickNextResetWindow(entries?.find((e) => e.provider === provider)?.usage?.windows);
			}
			if (!win?.resetAt) {
				ctx.ui.notify(`/nw: no window with a known reset time found for ${provider} — cannot schedule`, "error");
				return;
			}

			// Replace any prior job.
			cancelPending(ctx, false);

			const fireAt = Date.parse(win.resetAt) + SAFETY_MARGIN_MS;
			const scheduledProvider = provider;

			const ticker = setInterval(() => renderWidget(ctx), 30_000);
			ticker.unref?.();
			// Build the job first so fire() can key off its identity: only fire when
			// this exact job is still the current `pending` (never after it was
			// cancelled/replaced, and never when nothing is pending).
			const job: Pending = {
				prompt: text,
				fireAt,
				cancelTimer: () => {},
				ticker,
				provider: scheduledProvider,
				windowLabel: win.label,
				modelProvider: ctx.model?.provider,
			};
			job.cancelTimer = scheduleAt(fireAt, () => {
				if (pending !== job) return; // cancelled/replaced — do nothing
				clearInterval(job.ticker);
				pending = undefined;
				clearWidget(ctx);
				if (ctx.hasUI) ctx.ui.notify(`/nw: ${scheduledProvider} window reset — submitting deferred prompt`, "info");
				// Always triggers a turn; queue as follow-up if a turn is somehow live.
				pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });
			});
			pending = job;
			renderWidget(ctx);
			ctx.ui.notify(
				`/nw: scheduled — ${scheduledProvider} ${win.label} resets in ${formatDuration(Date.parse(win.resetAt) - Date.now())}; will resume at ${formatClock(fireAt)} (+5m margin) — "${preview(job.prompt)}". /nw cancel to abort.`,
				"info",
			);
		},
	});

	// A pending job binds the session (widget/notify/sendUserMessage all target
	// the session that was current at schedule time) and a specific provider's
	// window. If that binding goes stale — the user switches/forks the session,
	// or switches to a different provider — firing would target the wrong session
	// or a window we never waited for. Cancel rather than misfire.
	const cancelForReason = (ctx: ExtensionContext, reason: string) => {
		if (!pending) return;
		const prompt = pending.prompt;
		cancelPending(ctx, false);
		if (ctx.hasUI) ctx.ui.notify(`/nw: cancelled deferred prompt (${reason}) — "${preview(prompt)}"`, "warning");
	};
	// session_before_switch/before_fork fire while the old ctx is still valid, so
	// we can cleanly clear the widget before the session changes.
	pi.on("session_before_switch", (_e, ctx) => cancelForReason(ctx, "session switched"));
	pi.on("session_before_fork", (_e, ctx) => cancelForReason(ctx, "session forked"));
	// Provider switch mid-wait: the window we're waiting on no longer matches the
	// active provider. Compare raw model.provider strings (same on both sides).
	pi.on("model_select", (event, ctx) => {
		if (!pending) return;
		const newProvider = (event as { model?: { provider?: string } }).model?.provider;
		if (newProvider && newProvider !== pending.modelProvider) {
			cancelForReason(ctx, `switched to ${newProvider}`);
		}
	});

	pi.on("session_shutdown", () => {
		if (pending) {
			pending.cancelTimer();
			clearInterval(pending.ticker);
			pending = undefined;
		}
	});
}
