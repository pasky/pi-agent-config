import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getReadmePath } from "@earendil-works/pi-coding-agent";

const PROMPT_DIR = join(homedir(), ".pi", "agent", "system-prompts");

// Everything from the first of these markers on is kept (the "tail"); the part
// before it is the "head" that a provider prompt replaces. Only used by the
// bootstrap command and to recognise pi's default prompt: the prompt itself is applied
// through systemPromptOptions.customPrompt, so pi renders the tail sections.
const TAIL_MARKERS = [
	// pi >=0.87 renders structured sections as <name>...</name> blocks; the ones
	// after the default preamble/tools/rules/docs belong to the tail.
	"\n\n<addendum>\n",
	"\n\n<project_context>\n",
	"\n\n<skills>\n",
	"\n\n<cwd>\n",
	// pi >=0.79 emits project context (AGENTS.md/CLAUDE.md) under this XML block
	// for custom prompts. Must be listed so the split keeps it in the tail.
	"\n\n<project_context>\n\n",
	// Older pi versions used this markdown heading; kept for backward compat.
	"\n\n# Project Context\n\n",
	"\n\nThe following skills provide specialized instructions for specific tasks.",
	"\nCurrent date: ",
];

function splitSystemPrompt(prompt: string): { head: string; tail: string } {
	let splitAt = -1;

	for (const marker of TAIL_MARKERS) {
		const idx = prompt.indexOf(marker);
		if (idx !== -1 && (splitAt === -1 || idx < splitAt)) {
			splitAt = idx;
		}
	}

	if (splitAt === -1) {
		return { head: prompt, tail: "" };
	}

	return {
		head: prompt.slice(0, splitAt),
		tail: prompt.slice(splitAt),
	};
}

// Detect the pi package root from the default prompt head, which always
// contains "- Main documentation: <root>/README.md". Used to expand @PIROOT@
// placeholders so prompt files stay portable across machines/installs.
// Callers should pass the head only (not the tail, which contains arbitrary
// project context that could false-match). Tolerates Windows backslashes.
function detectPiRoot(promptHead: string): string | undefined {
	return promptHead.match(/^- Main documentation: (.+)[/\\]README\.md$/m)?.[1];
}

/**
 * Fold system prompt updates made before the current model's epoch into the leading
 * system message.
 *
 * pi appends prompt changes (e.g. our provider preamble after a model switch) as
 * mid-conversation system messages so the cached request prefix survives. A model
 * switch already invalidates the provider's prompt cache, though, so there is nothing
 * to preserve: the new model should see its own prompt at the head, not the previous
 * provider's prompt followed by an "Updated system prompt section" note.
 *
 * The epoch is the trailing run of assistant messages produced by the current model
 * (provider + model id); if the last assistant message came from another model, the
 * epoch has not started yet and every system message is folded. The prompt text
 * (content + sections) of everything before the epoch start is replayed with pi-ai's
 * own getCurrentSystemMessage, so the folded head is stable across the epoch's
 * requests, while updates made later within the epoch stay mid-conversation as pi
 * intends.
 *
 * Only prompt text is folded. Tool deltas (toolsAdded/toolsRemoved and anything else
 * on a system message) stay where they are: tool calls in the history may reference
 * tools that were declared and later removed, and providers replay that history from
 * the deltas' positions.
 *
 * Returns undefined when there is nothing to fold.
 */
export function foldSystemMessagesBeforeModelEpoch<T extends { role: string }>(
	messages: readonly T[],
	model: { provider: string; id: string },
): T[] | undefined {
	// pi always leads with the system message; leave anything unexpected untouched.
	if (messages[0]?.role !== "system") return undefined;
	type System = SystemMessage & T;

	let epochStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role: string; provider?: unknown; model?: unknown };
		if (message.role !== "assistant") continue;
		if (message.provider !== model.provider || message.model !== model.id) break;
		epochStart = i;
	}

	const hasText = (message: System) =>
		message.content.length > 0 || Object.keys(message.sections ?? {}).length > 0;
	const updates = messages
		.slice(1, epochStart)
		.filter((message): message is System => message.role === "system");
	if (!updates.some(hasText)) return undefined;

	const head = messages[0] as System;
	const textOnly = [head, ...updates].map(({ toolsAdded: _a, toolsRemoved: _r, ...rest }) => rest);
	const folded = getCurrentSystemMessage(textOnly);
	const { sections: _sections, ...headRest } = head;
	const newHead = {
		...headRest,
		content: folded?.content ?? "",
		...(folded?.sections ? { sections: folded.sections } : {}),
	} as System;

	const out: T[] = [newHead];
	for (const message of messages.slice(1, epochStart)) {
		if (message.role !== "system" || !hasText(message as System)) {
			out.push(message);
			continue;
		}
		// Keep whatever else the update carries (tool deltas, future fields) in place.
		const { content: _c, sections: _s, ...rest } = message as System;
		const next = { ...rest, content: "" } as System;
		if (isMeaningfulSystemMessage(next)) out.push(next);
	}
	out.push(...messages.slice(epochStart));
	return out;
}

// pi's section holding the custom prompt (or its default preamble), and the sections
// pi renders only for its default prompt, i.e. without a customPrompt (see
// buildSystemPromptSections in pi's system-prompt.ts).
const PREAMBLE_SECTION = "preamble";
const DEFAULT_ONLY_SECTIONS = ["tools", "rules", "docs"];
const PROVIDER_OWNED_SECTIONS = [PREAMBLE_SECTION, ...DEFAULT_ONLY_SECTIONS];

function hasContentText(message: SystemMessage): boolean {
	return message.content.length > 0;
}

/** Whether a system message still carries anything: text, sections, tool deltas or other fields. */
function isMeaningfulSystemMessage(message: SystemMessage): boolean {
	const { role: _r, content: _c, timestamp: _t, sections, ...rest } = message;
	return (
		hasContentText(message) ||
		Object.keys(sections ?? {}).length > 0 ||
		Object.values(rest).some((value) => value !== undefined && !(Array.isArray(value) && value.length === 0))
	);
}

/**
 * Make the request carry the provider preamble at the head, whatever the transcript says.
 *
 * before_agent_start applies the provider prompt only to runs started by a prompt. Runs
 * an extension starts with a message (/review results, side-agent notifications) skip
 * it, and pi's between-turn refresh then records an update back to its default prompt
 * (default preamble plus <tools>/<rules>/<docs>). Sessions created before a provider
 * prompt existed also lead with the default prompt. Anthropic's subscription endpoint
 * rejects requests led by pi's default prompt (400 "Third-party apps now draw from your
 * extra usage"), so at request time the head gets the provider preamble and loses the
 * default-only sections, and later system messages lose those sections too (dropped
 * when nothing else remains). The result depends only on the transcript and the
 * prompt file, so the head stays stable across requests and its cache keeps hitting.
 *
 * Heads whose prompt is opaque content (a forced prompt) are left alone. Returns
 * undefined when nothing changes.
 */
export function enforceProviderPreamble<T extends { role: string }>(
	messages: readonly T[],
	preamble: string,
): T[] | undefined {
	type System = SystemMessage & T;
	const head = messages[0] as System | undefined;
	if (head?.role !== "system" || !head.sections || hasContentText(head)) return undefined;

	const owns = (sections: SystemMessage["sections"]) =>
		Object.keys(sections ?? {}).some((name) => PROVIDER_OWNED_SECTIONS.includes(name));
	const strip = (sections: SystemMessage["sections"]) =>
		Object.fromEntries(Object.entries(sections ?? {}).filter(([name]) => !PROVIDER_OWNED_SECTIONS.includes(name)));

	let changed = head.sections[PREAMBLE_SECTION] !== preamble || DEFAULT_ONLY_SECTIONS.some((name) => name in head.sections!);
	const out: T[] = [{ ...head, sections: { [PREAMBLE_SECTION]: preamble, ...strip(head.sections) } } as System];
	for (const message of messages.slice(1)) {
		const system = message as System;
		if (message.role !== "system" || !owns(system.sections)) {
			out.push(message);
			continue;
		}
		changed = true;
		const { sections, ...rest } = system;
		const kept = strip(sections);
		const next = (Object.keys(kept).length > 0 ? { ...rest, sections: kept } : rest) as System;
		if (isMeaningfulSystemMessage(next)) out.push(next);
	}
	return changed ? out : undefined;
}

function getPromptPath(provider: string): string {
	return join(PROMPT_DIR, `${provider}.md`);
}

/**
 * The provider's custom preamble from ~/.pi/agent/system-prompts/<provider>.md, with
 * @PIROOT@ expanded to the pi package root (the directory of pi's README, exactly as
 * pi's default docs section names it). Undefined when the provider has no prompt file.
 */
function resolveProviderPreamble(provider: string): string | undefined {
	const path = getPromptPath(provider);
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trimEnd().replaceAll("@PIROOT@", dirname(getReadmePath()));
}

function updateStatus(ctx: ExtensionContext, provider: string | undefined) {
	if (!provider) {
		ctx.ui.setStatus("provider-system-prompt", undefined);
		return;
	}

	const path = getPromptPath(provider);
	ctx.ui.setStatus(
		"provider-system-prompt",
		existsSync(path) ? `(${provider}.md)` : undefined,
	);
}

export default function providerSystemPrompt(pi: ExtensionAPI) {
	pi.registerCommand("provider-prompt-bootstrap", {
		description: "Create ~/.pi/agent/system-prompts/<provider>.md from the current prompt head",
		handler: async (args, ctx) => {
			const provider = (args || "").trim() || ctx.model?.provider;
			if (!provider) {
				ctx.ui.notify("No provider selected", "error");
				return;
			}

			const path = getPromptPath(provider);
			if (existsSync(path)) {
				ctx.ui.notify(`Already exists: ${path}`, "warning");
				return;
			}

			let { head } = splitSystemPrompt(ctx.getSystemPrompt());
			const piRoot = detectPiRoot(head);
			if (piRoot) head = head.replaceAll(piRoot, "@PIROOT@");
			mkdirSync(PROMPT_DIR, { recursive: true });
			writeFileSync(path, `${head.trimEnd()}\n`, "utf8");

			updateStatus(ctx, provider);
			ctx.ui.notify(`Created ${path}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx, ctx.model?.provider);
	});

	pi.on("model_select", async (event, ctx) => {
		updateStatus(ctx, event.model.provider);
	});

	// Whether the user set an explicit prompt override (--system-prompt, .pi/SYSTEM.md,
	// ~/.pi/agent/SYSTEM.md, custom prompt templates), which this extension yields to.
	// Learned from before_agent_start; before the first prompt of this process, inferred
	// from the base prompt: pi's default rendering carries the docs section.
	let explicitOverride: boolean | undefined;

	pi.on("context_with_system", async (event, ctx) => {
		// A virtual (routed) selection names no physical model, so assistant messages
		// can't tell us where its epoch starts; leave such requests to pi.
		if (!ctx.model || ctx.model.api === "pi-virtual") return;
		let messages = foldSystemMessagesBeforeModelEpoch(event.messages, ctx.model) ?? event.messages;

		const override = explicitOverride ?? !detectPiRoot(splitSystemPrompt(ctx.getSystemPrompt()).head);
		const preamble = override ? undefined : resolveProviderPreamble(ctx.model.provider);
		if (preamble) messages = enforceProviderPreamble(messages, preamble) ?? messages;

		return messages !== event.messages ? { messages } : undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;

		// Yield to an explicit user prompt override. Otherwise this extension would
		// silently clobber the very prompt the user asked for.
		explicitOverride = !!event.systemPromptOptions?.customPrompt;
		if (explicitOverride) return;

		const customHead = resolveProviderPreamble(provider);
		if (customHead === undefined) return;
		// Swap in the provider prompt as pi's custom preamble instead of returning
		// a whole systemPrompt string: pi then still renders the addendum
		// (APPEND_SYSTEM.md), project context (AGENTS.md), skills and cwd sections
		// after it, without us having to find them in the rendered text.
		event.systemPromptOptions.customPrompt = customHead;
	});
}
