import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Footer countdown until the prompt cache entry expires.
 *
 * The TTL restarts when a request reads/writes the cache, i.e. at request
 * start. before_provider_headers fires for every request built by the session
 * (agent turns, pi's cache-warming refreshes, compaction), so it is the reset
 * signal. Display granularity: 30s steps down to 1m, then per second.
 * Shown only while the agent is idle and the entry is still alive.
 */

// Footer statuses are sorted by key: right after "mood", before "permissions" (YOLO mode).
const STATUS_KEY = "mood-cache-ttl";
const DEFAULT_TTL_S = 300;

function ttlSeconds(ctx: ExtensionContext): number | undefined {
	const promptCache = ctx.model?.promptCache;
	if (!promptCache) return ctx.model?.provider === "anthropic" ? DEFAULT_TTL_S : undefined;
	const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	return promptCache[retention] ?? promptCache.short;
}

export function formatRemaining(remainingMs: number): string {
	const s = Math.ceil(remainingMs / 1000);
	if (s < 60) return `${s}s`;
	const stepped = Math.ceil(s / 30) * 30;
	const m = Math.floor(stepped / 60);
	return stepped % 60 ? `${m}m30s` : `${m}m`;
}

export default function (pi: ExtensionAPI) {
	let lastRequestAt: number | undefined;
	let lastModelKey: string | undefined;
	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let shown: string | undefined;
	let running = false;

	const modelKey = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

	const render = () => {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		let text: string | undefined;
		const ttl = ttlSeconds(ctx);
		if (!running && lastRequestAt !== undefined && ttl !== undefined && modelKey(ctx) === lastModelKey) {
			const remaining = lastRequestAt + ttl * 1000 - Date.now();
			if (remaining > 0) {
				const theme = ctx.ui.theme;
				const label = formatRemaining(remaining);
				text = theme.fg(remaining < 60_000 ? "warning" : "muted", label) + theme.fg("dim", " │");
			}
		}
		if (text === shown) return;
		shown = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		shown = undefined;
		running = false;
		lastRequestAt = undefined;
		lastModelKey = undefined;
		// On resume, seed from the last request recorded on the branch.
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				lastRequestAt = entry.message.timestamp;
				lastModelKey = `${entry.message.provider}/${entry.message.model}`;
				break;
			}
			if (entry.type === "usage" && entry.kind === "cache_warm") {
				lastRequestAt = Date.parse(entry.timestamp);
				lastModelKey = `${entry.provider}/${entry.model}`;
				break;
			}
		}
		stopTimer();
		if (!ctx.hasUI) return;
		timer = setInterval(render, 1000);
		timer.unref?.();
		render();
	});

	pi.on("before_provider_headers", (_event, ctx) => {
		ctxRef = ctx;
		lastRequestAt = Date.now();
		lastModelKey = modelKey(ctx);
		render();
	});

	pi.on("agent_start", (_event, ctx) => {
		ctxRef = ctx;
		running = true;
		render();
	});

	pi.on("agent_settled", (_event, ctx) => {
		ctxRef = ctx;
		running = false;
		render();
	});

	pi.on("model_select", (_event, ctx) => {
		ctxRef = ctx;
		render();
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		ctxRef = undefined;
	});
}
