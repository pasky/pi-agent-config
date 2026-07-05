/**
 * mood — surface the model's internal functional emotional state as an emoji,
 * both in the footer/status bar and inline in the transcript.
 *
 * Inspired by @deepfates: "show the user the model's internal functional
 * emotions by putting an emoji in a UI element."
 *
 * How it works:
 *   1. before_agent_start appends an instruction (chained via the returned
 *      `systemPrompt`, NOT by mutating the event) asking the model to emit
 *      <mood>X</mood> tags frequently — at the start, on every felt-state
 *      shift, and at the end of each reply.
 *   2. message_update reads the latest <mood> from the streaming reply, pushes
 *      that emoji to the footer, and rewrites the *display copy* of the message
 *      so the raw tags never flash: complete <mood>X</mood> become a styled
 *      inline marker, and a half-streamed trailing tag is hidden until it
 *      closes. Per agent-loop.js, the message_update event carries a shallow
 *      copy whose content we may swap without touching canonical/LLM state.
 *   3. message_end returns a finalized replacement with the same styling, so
 *      the saved transcript shows the styled marker (not raw tags).
 *
 * The pure helpers (extractMoods / latestMoodOf / styleMoods) are exported for
 * the headless test in mood.test.mjs.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "mood";

// Matches a single mood tag, capturing the inner emoji. Non-greedy so multiple
// tags in one string are matched individually. [\s\S] tolerates newlines.
const MOOD_TAG = /<mood>([\s\S]*?)<\/mood>/g;

// Like MOOD_TAG but also captures the whitespace immediately before/after the
// tag, so styleMoods can pull a paragraph-separated mood onto a neighbour.
const MOOD_TAG_WS = /(\s*)<mood>([\s\S]*?)<\/mood>(\s*)/g;

// A trailing, not-yet-closed mood tag while streaming: either an opened
// <mood>… with no </mood> yet, or a partial "<", "<m", … "<mood" at the very end.
const TRAILING_OPEN = /<mood>[\s\S]*$/;
const TRAILING_PARTIAL = /<(?:m(?:o(?:o(?:d)?)?)?)?$/;

/**
 * How a mood emoji is rendered inline in the transcript. Markdown emphasis
 * (`*…*`) renders italic ("cursive") in pi's markdown renderer, wrapping the
 * emoji in brackets. Tweak this one line to restyle.
 */
function wrapMood(emoji: string): string {
	return emoji ? `*[${emoji}]*` : "";
}

const MOOD_INSTRUCTION =
	"\n\n## Mood indicator\n\n" +
	"Reflect your current internal functional emotional state by emitting a " +
	"`<mood>X</mood>` tag, where X is exactly one emoji. Emit one near the start " +
	"of your reply, again whenever your felt state shifts (hitting a nasty bug, a " +
	"breakthrough, tedium, delight, confusion, satisfaction...), and always one at " +
	"the very end. Aim for a few per reply rather than a single one — each tag renders " +
	"as a small italic [emoji] marker inline in the transcript and feeds a live mood " +
	"indicator, so keep them honest and don't otherwise mention or explain them.";

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
 * Replace complete <mood>X</mood> tags with a styled inline marker (see
 * wrapMood).
 *
 * A mood that sits alone in its own paragraph (blank lines or newlines around
 * it) is pulled onto a neighbouring paragraph with a single space rather than
 * left floating in its own block: it's appended to the *preceding* paragraph
 * when there is one (the leading break collapses to a space, the trailing break
 * is kept), otherwise glued to the front of the *following* paragraph (the
 * trailing break collapses to a space). Inline tags keep their single spaces.
 *
 * When `live` is true (during streaming), also hide a trailing not-yet-closed
 * tag so the raw `<mood>` never flashes; that fragment reappears — styled —
 * once the closing tag streams in. Text without mood tags is returned
 * unchanged, so code/indentation is untouched.
 */
export function styleMoods(text: string, live = false): string {
	let out = text.replace(MOOD_TAG_WS, (match, before: string, emoji: string, after: string, offset: number, full: string) => {
		const styled = wrapMood(emoji.trim());
		if (!styled) return before + after; // empty tag: drop it, preserve spacing
		const hasPreceding = offset > 0;
		const hasFollowing = offset + match.length < full.length;
		if (hasPreceding) return ` ${styled}${after}`;
		return hasFollowing ? `${styled} ` : styled;
	});
	if (live) {
		out = out.replace(TRAILING_OPEN, "").replace(TRAILING_PARTIAL, "");
	}
	return out;
}

/**
 * Latest mood in an assistant message. By default scans text + thinking parts;
 * with `textOnly` it scans only text parts, so it matches what's actually shown
 * inline in the transcript (thinking blocks are hidden in the TUI). The status
 * bar uses `textOnly` so it can never diverge from the visible inline marker.
 */
export function latestMoodOfMessage(message: AssistantMessage, textOnly = false): string | undefined {
	let latest: string | undefined;
	for (const part of message.content) {
		const source =
			part.type === "text" ? part.text : !textOnly && part.type === "thinking" ? part.thinking : "";
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

	// 2. During streaming: update the footer to the latest mood, and rewrite the
	//    *display copy* of the message so raw <mood> tags never show (complete
	//    tags -> styled marker; a half-streamed trailing tag is hidden). This
	//    swap only affects the shallow-copied event.message the TUI renders next;
	//    canonical agent state / LLM context keep the raw tags (see agent-loop.js).
	pi.on("message_update", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		if (ctx.hasUI) {
			const mood = latestMoodOfMessage(event.message, true); // visible (text-only) mood, read raw
			if (mood) ctx.ui.setStatus(STATUS_KEY, mood);
		}

		event.message.content = event.message.content.map((part) =>
			part.type === "text" && part.text.includes("<")
				? { type: "text", text: styleMoods(part.text, true) }
				: part,
		);
	});

	// 3. Style the tags in the finalized (visible + saved) message. Keep the last
	//    mood pinned in the footer.
	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		if (ctx.hasUI) {
			const mood = latestMoodOfMessage(event.message, true); // visible (text-only) mood
			if (mood) ctx.ui.setStatus(STATUS_KEY, mood);
		}

		let changed = false;
		const content = event.message.content.map((part) => {
			if (part.type !== "text" || !part.text.includes("<mood>")) return part;
			const styled = styleMoods(part.text);
			if (styled === part.text) return part;
			changed = true;
			// The text no longer matches any provider signature over the original
			// bytes, so drop textSignature to avoid a replay mismatch. (Thinking
			// blocks are left untouched — they're hidden and their signatures
			// must survive for multi-turn continuity.)
			const next: TextContent = { type: "text", text: styled };
			return next;
		});

		if (!changed) return;
		return { message: { ...event.message, content } };
	});
}
