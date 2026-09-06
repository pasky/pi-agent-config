import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * One-shot deferred abort: finish the response and every tool in its batch.
 * Keep retries and automatic compaction suppressed until agent_settled; an
 * already-issued abort cannot be undone by cancelling the pending request.
 */
export default function (pi: ExtensionAPI) {
	let pending = false;
	let stopping = false;

	const reset = (ctx: ExtensionContext) => {
		pending = false;
		stopping = false;
		if (ctx.hasUI) ctx.ui.setStatus("stop-after-turn", undefined);
	};

	pi.registerCommand("stop-after-turn", {
		description: "Stop after the current response and tools finish; use 'cancel' to disarm",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg && arg !== "cancel") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /stop-after-turn [cancel]", "warning");
				return;
			}
			if (stopping) {
				if (ctx.hasUI) ctx.ui.notify("Already stopping; the abort cannot be undone. Send a new prompt once idle.", "info");
				return;
			}
			if (arg === "cancel") {
				reset(ctx);
				if (ctx.hasUI) ctx.ui.notify("Stop-after-turn cancelled.", "info");
				return;
			}
			// Manual compaction is busy too, but has no agent turn to stop.
			if (ctx.isIdle() || !ctx.signal) {
				if (ctx.hasUI) ctx.ui.notify("No active turn; no stop scheduled.", "info");
				return;
			}
			pending = true;
			if (ctx.hasUI) {
				ctx.ui.setStatus("stop-after-turn", "stop after this turn");
				ctx.ui.notify("Will stop after this response and all its tools finish. /stop-after-turn cancel to undo.", "info");
			}
		},
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!pending) return;
		pending = false;
		stopping = true;
		// turn_end runs after all tool results are recorded. Abort synchronously:
		// awaiting idle from this hook would deadlock the loop. In the TUI this
		// also restores queued steering/follow-up messages to the editor (like Esc).
		ctx.abort();
		if (ctx.hasUI) ctx.ui.setStatus("stop-after-turn", undefined);
	});

	// A failed response can schedule a retry with a fresh abort signal. Cancel
	// that too, before it reaches the provider, until the session fully settles.
	pi.on("turn_start", (_event, ctx) => {
		if (stopping) ctx.abort();
	});

	// Pi may prepare auto-compaction before noticing the aborted continuation.
	// Don't start automatic summarization while stopping; an explicit /compact
	// is a separate user request and should follow pi's normal handling.
	pi.on("session_before_compact", (event) => {
		if (stopping && event.reason !== "manual") return { cancel: true };
	});

	pi.on("agent_settled", (_event, ctx) => reset(ctx));
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}
