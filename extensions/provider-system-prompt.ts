import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getReadmePath } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROMPT_DIR = join(homedir(), ".pi", "agent", "system-prompts");

const TAIL_MARKERS = [
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

function getPromptPath(provider: string): string {
	return join(PROMPT_DIR, `${provider}.md`);
}

/**
 * Load `<provider>.md` and resolve its @PIROOT@ placeholders, or undefined when
 * there is no prompt for the provider. `piRoot` is detected from the default
 * prompt when available (see detectPiRoot); pass undefined to fall back to pi's
 * own package root.
 *
 * Fail closed: with no root at all, drop whole paragraphs containing unresolved
 * placeholders (e.g. the entire Pi documentation section) rather than sending
 * literal @PIROOT@ paths or an orphaned section header to the model.
 */
function loadProviderHead(
	provider: string,
	piRoot: string | undefined,
): { head: string; droppedPlaceholders: boolean } | undefined {
	const path = getPromptPath(provider);
	if (!existsSync(path)) return undefined;

	let head = readFileSync(path, "utf8").trimEnd();
	const root = piRoot ?? detectPiRootFromPackage();
	if (root) return { head: head.replaceAll("@PIROOT@", root), droppedPlaceholders: false };
	if (!head.includes("@PIROOT@")) return { head, droppedPlaceholders: false };

	head = head
		.split("\n\n")
		.filter((block) => !block.includes("@PIROOT@"))
		.join("\n\n");
	return { head, droppedPlaceholders: true };
}

/** pi's package root, straight from pi itself (README.md lives at its root). */
function detectPiRootFromPackage(): string | undefined {
	try {
		return dirname(getReadmePath());
	} catch {
		return undefined;
	}
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

	// Subagents (pi-amplike) run with no extensions loaded, so the
	// before_agent_start hook below never fires for them; without this they'd
	// silently run on pi's default prompt instead of the provider's. Amplike asks
	// on this channel which prompt a subagent session should use — it knows
	// nothing about per-provider prompting, we just answer the question.
	// Synchronous by contract (pi builds the system prompt synchronously).
	pi.events.on("amplike:system_prompt", (data) => {
		const request = data as {
			provider?: string;
			systemPrompt: string | undefined;
		};
		if (!request?.provider) return;
		// No default prompt string to mine for the root here (the request carries
		// the custom-prompt slot, which is normally empty), so resolve from pi.
		const loaded = loadProviderHead(request.provider, undefined);
		if (loaded) request.systemPrompt = loaded.head;
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx, ctx.model?.provider);
	});

	pi.on("model_select", async (event, ctx) => {
		updateStatus(ctx, event.model.provider);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;

		const { head: defaultHead, tail } = splitSystemPrompt(event.systemPrompt);
		const loaded = loadProviderHead(provider, detectPiRoot(defaultHead));
		if (!loaded) return;
		if (loaded.droppedPlaceholders) {
			ctx.ui.notify(
				`provider-system-prompt: dropped @PIROOT@ sections in ${provider}.md (pi root not resolvable)`,
				"warning",
			);
		}
		return {
			systemPrompt: `${loaded.head}${tail}`,
		};
	});
}
