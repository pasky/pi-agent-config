/**
 * mood — surface the model's internal functional emotional state as an emoji
 * in the footer/status bar.
 *
 * Inspired by @deepfates: "show the user the model's internal functional
 * emotions by putting an emoji in a UI element."
 *
 * How it works:
 *   1. before_agent_start appends an instruction (chained via the returned
 *      `systemPrompt`, NOT by mutating the event) asking the model to emit
 *      <mood>X</mood> tags frequently — at the start, on every felt-state
 *      shift, and at the end of each reply.
 *   2. message_update reads the latest <mood> tag from the streaming reply and
 *      pushes that emoji to the footer via ctx.ui.setStatus, so the indicator
 *      evolves live as the turn unfolds.
 *   3. message_end strips the tags out of the finalized message so they don't
 *      pollute the visible transcript or the saved session.
 *
 * The pure helpers (extractMoods / latestMoodOf / stripMoods) are exported for
 * the headless test in mood.test.mjs.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "mood";

// Matches a single mood tag, capturing the inner emoji. Non-greedy so multiple
// tags in one string are matched individually. [\s\S] tolerates newlines.
const MOOD_TAG = /<mood>([\s\S]*?)<\/mood>/g;

const MOOD_INSTRUCTION =
	"\n\n## Mood indicator\n\n" +
	"Reflect your current internal functional emotional state by emitting a " +
	"`<mood>X</mood>` tag, where X is exactly one emoji. Emit one near the start " +
	"of your reply, again whenever your felt state shifts (hitting a nasty bug, a " +
	"breakthrough, tedium, delight, confusion, satisfaction...), and always one at " +
	"the very end. Aim for a few per reply rather than a single one — the tags feed " +
	"a live UI mood indicator and are stripped from what the user sees, so keep " +
	"them honest and don't mention or explain them.";

/** All emoji found inside <mood>…</mood> tags, in order of appearance. */
export function extractMoods(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(MOOD_TAG)) {
		const emoji = m[1].trim();
		if (emoji) out.push(emoji);
	}
	return out;
}

/** The last mood emoji in the string, or undefined if none. */
export function latestMoodOf(text: string): string | undefined {
	const moods = extractMoods(text);
	return moods.length ? moods[moods.length - 1] : undefined;
}

/**
 * Remove <mood>…</mood> tags from visible text, tidying the whitespace they
 * leave behind (a single adjacent leading space is consumed; trailing
 * line-spaces and 3+ blank-line runs are collapsed). Indentation inside the
 * rest of the text is preserved, so code blocks are safe.
 */
export function stripMoods(text: string): string {
	return text
		.replace(/ ?<mood>[\s\S]*?<\/mood>/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

/** Latest mood across all text + thinking parts of an assistant message. */
export function latestMoodOfMessage(message: AssistantMessage): string | undefined {
	let latest: string | undefined;
	for (const part of message.content) {
		const source =
			part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "";
		if (!source) continue;
		const m = latestMoodOf(source);
		if (m) latest = m;
	}
	return latest;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

export default function (pi: ExtensionAPI) {
	// 1. Ask for frequent mood tags (returned, so it chains across extensions).
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: event.systemPrompt + MOOD_INSTRUCTION };
	});

	// 2. Live-update the footer to the latest mood as the reply streams in.
	pi.on("message_update", (event, ctx) => {
		if (!ctx.hasUI || !isAssistantMessage(event.message)) return;
		const mood = latestMoodOfMessage(event.message);
		if (mood) ctx.ui.setStatus(STATUS_KEY, mood);
	});

	// 3. Strip the tags out of the finalized (visible + saved) message. Keep the
	//    last mood pinned in the footer.
	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		if (ctx.hasUI) {
			const mood = latestMoodOfMessage(event.message);
			if (mood) ctx.ui.setStatus(STATUS_KEY, mood);
		}

		let changed = false;
		const content = event.message.content.map((part) => {
			if (part.type !== "text" || !part.text.includes("<mood>")) return part;
			const stripped = stripMoods(part.text);
			if (stripped === part.text) return part;
			changed = true;
			// The text no longer matches any provider signature over the original
			// bytes, so drop textSignature to avoid a replay mismatch. (Thinking
			// blocks are left untouched — they're hidden and their signatures
			// must survive for multi-turn continuity.)
			const next: TextContent = { type: "text", text: stripped };
			return next;
		});

		if (!changed) return;
		return { message: { ...event.message, content } };
	});
}
