/**
 * /review command — run a pi-amplike subagent to review recent git changes.
 *
 * Usage:
 *   /review                       review changes since HEAD~1 (default prompt)
 *   /review main                  review changes since main..
 *   /review main focus on auth    review changes since main.. with a custom prompt
 *   /review -mode deep origin/dev be ruthless about edge cases
 *
 * The finished review is added to the conversation as a permanent transcript
 * block (same renderer as the subagent tool / /btw). The model sees it as a
 * single `user` message wrapping the whole thing — request, commit log and the
 * review — tagged with the reviewer model/mode so the main model knows it came
 * from a separate reviewer. Follow up with e.g. "consider the review above".
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";

import { resolveModelAndThinking } from "../packages/pi-amplike/extensions/lib/mode-utils.js";
import { type SingleResult, renderResults, runSubagent } from "../packages/pi-amplike/extensions/lib/subagent-core.js";

const DEFAULT_SINCE = "HEAD~1";
const WIDGET_KEY = "review";
const REVIEW_TYPE = "review-result";

// --------------------------------------------------------------------------
// Pure helpers (exported for the headless tests in review.test.mjs).
// --------------------------------------------------------------------------

/**
 * Parse `/review` arguments: optional `-mode <name>`, then positional
 * `[git-since] [prompt]`.
 */
export function parseReviewArgs(
	args: string,
	defaultSince = DEFAULT_SINCE,
): { modeOpt?: string; since: string; prompt: string } {
	let remaining = args ?? "";
	let modeOpt: string | undefined;
	const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
	if (modeMatch) {
		modeOpt = modeMatch[1];
		remaining = remaining.replace(modeMatch[0], " ");
	}
	remaining = remaining.trim();

	let since = defaultSince;
	let prompt = "";
	if (remaining) {
		const m = remaining.match(/^(\S+)(?:\s+([\s\S]*))?$/);
		if (m) {
			since = m[1];
			prompt = (m[2] || "").trim();
		}
	}
	if (!prompt) prompt = `review changes since ${since} carefully - analyze, debate and challenge`;
	return { modeOpt, since, prompt };
}

/**
 * Build the single `user`-message text the model sees, wrapping the whole pair
 * (request + commit log + review) and tagged with the reviewer model/mode. When
 * `error` is set the block is marked incomplete and any partial review is kept.
 */
export function buildReviewContent(p: {
	reviewerModel: string;
	mode?: string;
	since: string;
	range: string;
	prompt: string;
	gitLog: string;
	reviewText: string;
	error?: string;
}): string {
	const attrs = [
		`reviewer="${p.reviewerModel}"`,
		p.mode ? `mode="${p.mode}"` : undefined,
		`since="${p.since}"`,
		p.error ? `status="incomplete"` : undefined,
	]
		.filter(Boolean)
		.join(" ");

	const lines = [`<code-review ${attrs}>`];
	if (p.error) {
		lines.push(
			`NOTE: the reviewer subagent did NOT finish (${p.error}). Any partial output below may be incomplete.`,
			"",
		);
	}
	lines.push(
		`A separate reviewer subagent was asked to review the changes in \`git log ${p.range}\`. Its request and review follow.`,
		"",
		`Request: ${p.prompt}`,
		"",
		"Commit log:",
		p.gitLog,
		"",
		p.error ? "Review (partial):" : "Review:",
		p.reviewText || "(no review text produced)",
		"</code-review>",
	);
	return lines.join("\n");
}

interface ReviewDetails {
	range: string;
	result: SingleResult;
}

export default function (pi: ExtensionAPI) {
	// Render the persisted review block in the transcript with the same renderer
	// used by the subagent tool and /btw (full output, Ctrl+O to expand).
	// Always render expanded so the full review is readable in the transcript
	// (the collapsed minibox is only used for the live progress widget).
	pi.registerMessageRenderer<ReviewDetails>(REVIEW_TYPE, (message, _options, theme) => {
		const d = message.details;
		if (!d?.result) return undefined;
		return renderResults([d.result], { expanded: true, label: `review ${d.range}` }, theme);
	});

	pi.registerCommand("review", {
		description: "Review git changes via a subagent, kept in the transcript + context (-mode <name>, [git-since] [prompt])",
		handler: async (args, ctx) => {
			const { modeOpt, since, prompt } = parseReviewArgs(args, DEFAULT_SINCE);

			if (!ctx.model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			// --- Resolve model/thinking from -mode (falls back to current) ---
			const { model, thinkingLevel } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode: modeOpt },
			);
			if (!model) {
				ctx.ui.notify("No model available.", "error");
				return;
			}

			// --- Collect the commit log for the range ---
			const range = `${since}..`;
			const log = await pi.exec("git", ["log", "--stat", range], { cwd: ctx.cwd });
			if (log.code !== 0) {
				ctx.ui.notify(`git log ${range} failed: ${(log.stderr || log.stdout).trim()}`, "error");
				return;
			}
			const gitLog = log.stdout.trim() || "(no commits in range)";

			// --- Build the subagent task ---
			const task = [
				prompt,
				"",
				`The changes to review are the commits in \`git log ${range}\` (i.e. since ${since}).`,
				"",
				"Commit log:",
				"```",
				gitLog,
				"```",
			].join("\n");

			const tools: AgentTool<any>[] = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
			];
			const systemPrompt = ctx.getSystemPrompt();
			const apiKeyResolver = async (_provider: string) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				return auth.ok ? auth.apiKey : undefined;
			};

			// --- Run the subagent, live progress in a widget. Always clear the
			// widget afterwards (even on throw/abort) so it can never get stuck. ---
			ctx.ui.setWidget(WIDGET_KEY, [`⏳ review ${range} (${model.provider}/${model.id})...`], { placement: "aboveEditor" });
			let result: SingleResult;
			try {
				result = await runSubagent(
					systemPrompt,
					task,
					tools,
					model,
					thinkingLevel,
					apiKeyResolver,
					ctx.signal,
					(r) => ctx.ui.setWidget(
						WIDGET_KEY,
						(_tui, theme) => renderResults([r], { expanded: false, label: `review ${range}` }, theme),
						{ placement: "aboveEditor" },
					),
				);
			} finally {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}

			const failed = result.exitCode !== 0;
			const reviewText = result.finalOutput.trim();

			// Hard failure with nothing to keep: just notify, nothing to persist.
			if (failed && !reviewText && result.displayItems.length === 0) {
				ctx.ui.notify(`review failed: ${result.errorMessage || "unknown error"}`, "error");
				return;
			}
			if (failed) {
				ctx.ui.notify(`review incomplete (${result.errorMessage || "error"}); partial output kept`, "warning");
			}

			// The model sees one `user` message wrapping the whole pair, tagged with
			// the reviewer model/mode (and marked incomplete on failure). On failure
			// we still persist a block so nothing — including partial work — is lost.
			const contentText = buildReviewContent({
				reviewerModel: `${model.provider}/${model.id}`,
				mode: modeOpt,
				since,
				range,
				prompt,
				gitLog,
				reviewText,
				error: failed ? (result.errorMessage || "unknown error") : undefined,
			});

			// Permanent transcript block (rich render via details + renderer above).
			pi.sendMessage<ReviewDetails>(
				{
					customType: REVIEW_TYPE,
					content: [{ type: "text", text: contentText }],
					display: true,
					details: { range, result },
				},
				{ triggerTurn: false },
			);
		},
	});
}
