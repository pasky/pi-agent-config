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
 * bus. We ask for a fresh snapshot of all providers' usage, pick the window that
 * resets soonest for the current provider (that's the short rolling window,
 * "5h" on Anthropic), and schedule off its `resetAt` timestamp.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Safety margin past the reported reset time — reset clocks can be slightly off
// and we never want to fire while the old window is technically still live.
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const WIDGET_KEY = "nw";
const CORE_TIMEOUT_MS = 3000;

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

function requestCurrentProvider(pi: ExtensionAPI): Promise<string | undefined> {
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
			reply: (payload: { state?: { provider?: string } }) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(payload?.state?.provider);
			},
		});
	});
}

function requestEntries(pi: ExtensionAPI): Promise<ProviderUsageEntry[] | undefined> {
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				resolve(undefined);
			}
		}, CORE_TIMEOUT_MS);
		// Use cached data (no force): `resetAt` is a slow-moving timestamp and
		// sub-core already refreshes it every ~60s, so the cache is fresh enough.
		// A forced multi-provider network fetch could easily exceed our timeout
		// and produce a spurious "could not read usage" error.
		pi.events.emit("sub-core:request", {
			type: "entries",
			reply: (payload: { entries?: ProviderUsageEntry[] }) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(payload?.entries);
			},
		});
	});
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
		timer: ReturnType<typeof setTimeout>;
		ticker: ReturnType<typeof setInterval>;
		provider?: string;
		windowLabel?: string;
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
		clearTimeout(pending.timer);
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

			// Fetch fresh usage and figure out which window governs us.
			const [provider, entries] = await Promise.all([
				requestCurrentProvider(pi),
				requestEntries(pi),
			]);
			if (!entries?.length) {
				ctx.ui.notify("/nw: could not read usage from sub-core (is the sub extension loaded?)", "error");
				return;
			}
			const targetProvider = provider ?? ctx.model?.provider;
			const entry =
				entries.find((e) => e.provider === targetProvider) ??
				entries.find((e) => pickNextResetWindow(e.usage?.windows));
			const win = pickNextResetWindow(entry?.usage?.windows);
			if (!entry || !win?.resetAt) {
				ctx.ui.notify("/nw: no window with a known reset time found — cannot schedule", "error");
				return;
			}

			// Replace any prior job.
			cancelPending(ctx, false);

			const fireAt = Date.parse(win.resetAt) + SAFETY_MARGIN_MS;
			const delay = Math.max(0, fireAt - Date.now());

			const fire = () => {
				const p = pending;
				pending = undefined;
				clearWidget(ctx);
				if (!p) return;
				if (ctx.hasUI) ctx.ui.notify(`/nw: window reset — submitting deferred prompt`, "info");
				// Always triggers a turn; queue as follow-up if a turn is somehow live.
				pi.sendUserMessage(p.prompt, { deliverAs: "followUp" });
			};

			const timer = setTimeout(fire, delay);
			timer.unref?.();
			const ticker = setInterval(() => renderWidget(ctx), 30_000);
			ticker.unref?.();

			pending = {
				prompt: text,
				fireAt,
				timer,
				ticker,
				provider: entry.provider,
				windowLabel: win.label,
			};
			renderWidget(ctx);
			ctx.ui.notify(
				`/nw: scheduled — ${entry.provider} ${win.label} resets in ${formatDuration(Date.parse(win.resetAt) - Date.now())}; will resume at ${formatClock(fireAt)} (+5m margin).`,
				"info",
			);
		},
	});

	// A pending job binds the session it was scheduled in (its widget, notify,
	// and the eventual sendUserMessage all target that session). If the user
	// switches/forks/reloads the session — possibly hours later — that binding
	// goes stale and the prompt would fire into the wrong session. Cancel on any
	// such transition rather than misfire. (session_before_switch fires while the
	// old ctx is still valid so we can cleanly clear the widget; session_start
	// covers forks/reloads that land in a fresh session.)
	const cancelOnSessionChange = (_event: unknown, ctx: ExtensionContext) => {
		if (pending) {
			const prompt = pending.prompt;
			cancelPending(ctx, false);
			if (ctx.hasUI) ctx.ui.notify(`/nw: cancelled deferred prompt (session changed) — "${preview(prompt)}"`, "warning");
		}
	};
	pi.on("session_before_switch", cancelOnSessionChange);
	pi.on("session_start", cancelOnSessionChange);

	pi.on("session_shutdown", () => {
		if (pending) {
			clearTimeout(pending.timer);
			clearInterval(pending.ticker);
			pending = undefined;
		}
	});
}
