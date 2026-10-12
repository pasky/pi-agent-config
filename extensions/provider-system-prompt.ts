import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROMPT_DIR = join(homedir(), ".pi", "agent", "system-prompts");

// Everything from the first of these markers on is kept (the "tail"); the part
// before it is the "head" that a provider prompt replaces. Only used by the
// bootstrap command and for @PIROOT@ detection: the prompt itself is applied
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
 * epoch has not started yet and every system message is folded. Everything before
 * the epoch start is replayed with pi-ai's own getCurrentSystemMessage (the same
 * semantics providers use to collapse system messages), so the folded head is stable
 * across the epoch's requests and its cache keeps hitting, while updates made later
 * within the epoch stay mid-conversation as pi intends.
 *
 * Returns undefined when there is nothing to fold.
 */
export function foldSystemMessagesBeforeModelEpoch<T extends { role: string }>(
	messages: readonly T[],
	model: { provider: string; id: string },
): T[] | undefined {
	// pi always leads with the system message; leave anything unexpected untouched.
	if (messages[0]?.role !== "system") return undefined;

	let epochStart = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role: string; provider?: unknown; model?: unknown };
		if (message.role !== "assistant") continue;
		if (message.provider !== model.provider || message.model !== model.id) break;
		epochStart = i;
	}

	const prefix = messages.slice(0, epochStart);
	if (prefix.filter((message) => message.role === "system").length < 2) return undefined;

	const head = getCurrentSystemMessage(prefix);
	if (!head) return undefined;
	return [
		head as unknown as T,
		...prefix.filter((message) => message.role !== "system"),
		...messages.slice(epochStart),
	];
}

function getPromptPath(provider: string): string {
	return join(PROMPT_DIR, `${provider}.md`);
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

	pi.on("context_with_system", async (event, ctx) => {
		if (!ctx.model) return;
		const messages = foldSystemMessagesBeforeModelEpoch(event.messages, ctx.model);
		return messages ? { messages } : undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;

		// Yield to an explicit user prompt override (--system-prompt, .pi/SYSTEM.md,
		// ~/.pi/agent/SYSTEM.md, custom prompt templates). Otherwise this extension
		// would silently clobber the very prompt the user asked for.
		if (event.systemPromptOptions?.customPrompt) return;

		const path = getPromptPath(provider);
		if (!existsSync(path)) return;

		let customHead = readFileSync(path, "utf8").trimEnd();
		const { head: defaultHead } = splitSystemPrompt(event.systemPrompt);
		const piRoot = detectPiRoot(defaultHead);
		if (piRoot) {
			customHead = customHead.replaceAll("@PIROOT@", piRoot);
		} else if (customHead.includes("@PIROOT@")) {
			// Fail closed: drop whole paragraphs containing unresolved placeholders
			// (e.g. the entire Pi documentation section) rather than sending literal
			// @PIROOT@ paths or an orphaned section header to the model.
			customHead = customHead
				.split("\n\n")
				.filter((block) => !block.includes("@PIROOT@"))
				.join("\n\n");
			ctx.ui.notify(
				`provider-system-prompt: dropped @PIROOT@ sections in ${provider}.md (marker missing from default prompt)`,
				"warning",
			);
		}
		// Swap in the provider prompt as pi's custom preamble instead of returning
		// a whole systemPrompt string: pi then still renders the addendum
		// (APPEND_SYSTEM.md), project context (AGENTS.md), skills and cwd sections
		// after it, without us having to find them in the rendered text.
		event.systemPromptOptions.customPrompt = customHead;
	});
}
