/**
 * /review command + `review` tool — run a pi-amplike subagent to review recent
 * git changes. The command is human-driven (transcript block); the tool lets the
 * main model self-invoke a review and get the findings back as a tool result.
 *
 * Usage (command):
 *   /review                       review changes since HEAD~1 (default prompt)
 *   /review main                  review changes since main..
 *   /review main focus on auth    review changes since main.. — "focus on auth"
 *                                 is APPENDED to the default review prompt
 *   /review -mode deep origin/dev be ruthless about edge cases
 *
 * The command runs the reviewer in the BACKGROUND (fire-and-forget, like /btw):
 * it returns immediately so the interactive loop keeps handling input while the
 * review runs, instead of blocking the handler (which would drop typed input and
 * throw "Agent is already processing"). When the review finishes it is added to
 * the conversation as a permanent transcript block (same renderer as the
 * subagent tool / /btw). The model sees it as a single `user` message wrapping
 * the whole thing — request, commit log and the review — tagged with the
 * reviewer model/mode so the main model knows it came from a separate reviewer.
 * Follow up with e.g. "consider the review above".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadModeSpec, resolveModelAndThinking } from "../packages/pi-amplike/extensions/lib/mode-utils.js";
import { type SingleResult, renderResults, runSubagent } from "../packages/pi-amplike/extensions/lib/subagent-core.js";

const DEFAULT_SINCE = "HEAD~1";
// When no -mode is given, the reviewer should be a fresh perspective from a
// strong model: default to "deep" — unless we're effectively already running
// "deep", in which case fall back to "smart" so we don't just clone the same
// heavyweight setup.
//
// We only need to answer "am I in deep?", so just load deep's spec and compare
// the current model+thinking to it directly (rather than reinventing full mode
// inference). "In deep" requires the same provider+modelId and — when deep pins
// a thinking level — the same thinking level (so opus@off isn't taken for a
// opus@high deep). Both this check and the validation below use loadModeSpec,
// the same lookup resolveModelAndThinking uses to actually apply the mode, so
// detection/validation/application can't disagree. Returns undefined when the
// chosen mode isn't defined — the caller then leaves the mode unset (review runs
// on the current model) rather than mislabeling it.
export async function resolveDefaultReviewMode(
	cwd: string,
	currentModel: { provider?: string; id?: string } | undefined,
	currentThinkingLevel: string,
): Promise<string | undefined> {
	const deep = await loadModeSpec(cwd, "deep");
	const inDeep =
		!!deep &&
		currentModel?.provider === deep.provider &&
		currentModel?.id === deep.modelId &&
		(deep.thinkingLevel == null || deep.thinkingLevel === currentThinkingLevel);
	const candidate = inDeep ? "smart" : "deep";
	// Only use a mode that actually exists (same lookup used to apply it).
	return (await loadModeSpec(cwd, candidate)) ? candidate : undefined;
}

const WIDGET_KEY = "review";
const REVIEW_TYPE = "review-result";

// --------------------------------------------------------------------------
// Pure helpers (exported for the headless tests in review.test.mjs).
// --------------------------------------------------------------------------

/**
 * The default review prompt for a given range. Always used as the base; any
 * user-supplied prompt is appended to it (never replaces it).
 */
export function defaultReviewPrompt(since: string): string {
	return `review changes since ${since} carefully (both form and substance) - analyze, critique, debate and challenge`;
}

/**
 * Compose the final reviewer prompt: the default prompt for `since`, with any
 * custom instructions APPENDED (so the user/model focus augments, not overrides,
 * the baseline review intent).
 */
export const PROMPT_AUGMENT_PREFIX =
	"Additionally (this augments, and must not weaken or replace, the baseline review above):";

export function composeReviewPrompt(since: string, customPrompt?: string): string {
	const base = defaultReviewPrompt(since);
	const custom = (customPrompt || "").trim();
	// Frame the custom text as an explicit augmentation so a conflicting later
	// instruction can't be read as overriding the baseline review intent.
	return custom ? `${base}\n\n${PROMPT_AUGMENT_PREFIX} ${custom}` : base;
}

/**
 * Parse `/review` arguments: optional `-mode <name>`, then positional
 * `[git-since] [prompt]`. `customPrompt` is the raw user text ("" if none);
 * `prompt` is the composed prompt (default + appended custom).
 */
export function parseReviewArgs(
	args: string,
	defaultSince = DEFAULT_SINCE,
): { modeOpt?: string; since: string; prompt: string; customPrompt: string } {
	let remaining = args ?? "";
	let modeOpt: string | undefined;
	const modeMatch = remaining.match(/(?:^|\s)-mode\s+(\S+)/);
	if (modeMatch) {
		modeOpt = modeMatch[1];
		remaining = remaining.replace(modeMatch[0], " ");
	}
	remaining = remaining.trim();

	let since = defaultSince;
	let customPrompt = "";
	if (remaining) {
		const m = remaining.match(/^(\S+)(?:\s+([\s\S]*))?$/);
		if (m) {
			since = m[1];
			customPrompt = (m[2] || "").trim();
		}
	}
	return { modeOpt, since, prompt: composeReviewPrompt(since, customPrompt), customPrompt };
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

const ReviewToolParams = Type.Object({
	since: Type.Optional(
		Type.String({
			description: "Git ref to review changes since (default HEAD~1); the reviewed range is `<since>..` (e.g. 'main', 'HEAD~3', 'origin/dev').",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "Extra focus/instructions APPENDED to the default review prompt (e.g. 'focus on the auth changes and concurrency'). Optional.",
		}),
	),
	mode: Type.Optional(
		Type.String({
			description: "Amplike mode name for the reviewer subagent (e.g. 'deep'), only based on explicit user instructions.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	// Background /review bookkeeping (mirrors /btw): a per-invocation counter for
	// unique widget keys, and widgets that wait for turn_end to remove themselves
	// (a follow-up-delivered review block only renders at the turn boundary).
	let reviewCounter = 0;
	const pendingWidgetRemovals = new Map<string, () => void>();
	pi.on("turn_end", () => {
		for (const [, resolve] of pendingWidgetRemovals) resolve();
		pendingWidgetRemovals.clear();
	});

	// Shared review logic used by both the /review command and the `review` tool:
	// collect the commit log for the range, run a reviewer subagent over it, and
	// build the tagged transcript/tool content. Caller handles UI (widget vs.
	// tool onUpdate) and how the finished review is surfaced.
	async function performReview(opts: {
		cwd: string;
		modelRegistry: any;
		model: any;
		thinkingLevel: string;
		modeOpt?: string;
		since: string;
		prompt: string;
		parentSessionFile?: string;
		signal?: AbortSignal;
		onProgress?: (result: SingleResult, range: string) => void;
	}): Promise<
		| { ok: true; range: string; gitLog: string; result: SingleResult; reviewText: string; failed: boolean; contentText: string }
		| { ok: false; error: string }
	> {
		const { cwd, modelRegistry, model, thinkingLevel, modeOpt, since, prompt, parentSessionFile, signal, onProgress } = opts;

		// --- Collect the commit log for the range ---
		// `--end-of-options` so a `since` starting with `-` can't be smuggled in as a
		// git option (e.g. `--output=...`) — important now that `since` is also
		// model-supplied via the `review` tool.
		const range = `${since}..`;
		const log = await pi.exec("git", ["log", "--stat", "--end-of-options", range], { cwd });
		if (log.code !== 0) {
			return { ok: false, error: `git log ${range} failed: ${(log.stderr || log.stdout).trim()}` };
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

		const result = await runSubagent({
			cwd,
			modelRegistry,
			model,
			thinkingLevel,
			task,
			parentSessionFile,
			signal,
			onProgress: (r) => onProgress?.(r, range),
		});

		const failed = result.exitCode !== 0;
		const reviewText = result.finalOutput.trim();
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

		return { ok: true, range, gitLog, result, reviewText, failed, contentText };
	}

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
			const { modeOpt: modeArg, since, prompt } = parseReviewArgs(args, DEFAULT_SINCE);

			if (!ctx.model) {
				ctx.ui.notify("No model selected.", "error");
				return;
			}

			// No explicit -mode: default to deep (or smart if already in deep).
			const modeOpt = modeArg ?? (await resolveDefaultReviewMode(ctx.cwd, ctx.model, pi.getThinkingLevel()));

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

			const range = `${since}..`;
			// Unique widget key per invocation so concurrent /review's don't clobber.
			const widgetKey = `${WIDGET_KEY}-${++reviewCounter}`;
			ctx.ui.setWidget(widgetKey, [`⏳ review ${range} (${model.provider}/${model.id})...`], { placement: "aboveEditor" });

			// Fire-and-forget — run the review in the background (like /btw) instead
			// of awaiting it in the handler. A handler that blocks on long work keeps
			// the session out of its "streaming" state, so typed input is silently
			// dropped and then replayed into the review's own turn, throwing "Agent is
			// already processing". Returning immediately lets the interactive loop keep
			// handling input normally while the review runs.
			performReview({
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				model,
				thinkingLevel,
				modeOpt,
				since,
				prompt,
				parentSessionFile: ctx.sessionManager?.getSessionFile(),
				// no abort signal — runs to completion (matches /btw). ctx.signal would
				// be stale here: the handler returns immediately, so it no longer tracks
				// a live agent run.
				onProgress: (r, rng) => ctx.ui.setWidget(
					widgetKey,
					(_tui, theme) => renderResults([r], { expanded: false, label: `review ${rng}` }, theme),
					{ placement: "aboveEditor" },
				),
			}).then(async (outcome) => {
				if (!outcome.ok) {
					ctx.ui.setWidget(widgetKey, undefined);
					ctx.ui.notify(outcome.error, "error");
					return;
				}
				const { result, reviewText, failed, contentText } = outcome;

				// Hard failure with nothing to keep: just notify, nothing to persist.
				if (failed && !reviewText && result.displayItems.length === 0) {
					ctx.ui.setWidget(widgetKey, undefined);
					ctx.ui.notify(`review failed: ${result.errorMessage || "unknown error"}`, "error");
					return;
				}
				if (failed) {
					ctx.ui.notify(`review incomplete (${result.errorMessage || "error"}); partial output kept`, "warning");
				}

				// Deliver the finished review. Pass BOTH triggerTurn and deliverAs so core
				// picks the right path atomically at its own isStreaming check (no
				// read-then-act race): when streaming it takes deliverAs:"followUp" (the
				// review waits for the current turn to end, then the model reacts to it in
				// a fresh turn — it does NOT steer/interrupt mid-turn); when idle it falls
				// through to triggerTurn (responds immediately). Either way nothing throws
				// "Agent is already processing". On failure we still persist a block so
				// nothing (including partial work) is lost. The model sees one tagged
				// `user` message wrapping the whole pair (rich render via the renderer).
				const idle = ctx.isIdle();
				pi.sendMessage<ReviewDetails>(
					{
						customType: REVIEW_TYPE,
						content: [{ type: "text", text: contentText }],
						display: true,
						details: { range: outcome.range, result },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);

				// A follow-up-delivered block only renders when the current turn ends —
				// keep a widget up until then so the finished review isn't invisible.
				if (!idle) {
					ctx.ui.setWidget(widgetKey, [`✓ review ${outcome.range} ready — applying after the current turn`], { placement: "aboveEditor" });
					await new Promise<void>((resolve) => pendingWidgetRemovals.set(widgetKey, resolve));
				}
				ctx.ui.setWidget(widgetKey, undefined);
			}).catch((err) => {
				ctx.ui.setWidget(widgetKey, undefined);
				ctx.ui.notify(`review failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			});

			// Command returns immediately — the review runs in the background.
		},
	});

	// `review` tool: lets the main model self-invoke a review of recent git
	// changes and get the findings back as a tool result (kept in context
	// naturally, no transcript injection / triggerTurn needed).
	pi.registerTool({
		name: "review",
		label: (params: { since?: string }) => `Review ${params?.since ? `${params.since}..` : `${DEFAULT_SINCE}..`}`,
		description: [
			"Run a separate reviewer subagent over recent git changes (the commits in `git log <since>..`) and get its critique back.",
			"Use this to self-review your own committed work before declaring done, or when the user asks for a review.",
			"The reviewer is a fresh subagent with no conversation history \u2014 it inspects the repo and commit log independently.",
		].join(" "),
		parameters: ReviewToolParams,

		// Run sequentially: a review inspects repository state, so it must not race
		// concurrent bash/write/edit tool calls in the same assistant turn. Marking
		// this tool sequential forces the whole batch to run one-at-a-time.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const since = (params.since || DEFAULT_SINCE).trim() || DEFAULT_SINCE;
			const prompt = composeReviewPrompt(since, params.prompt);

			// No explicit mode: default to deep (or smart if already in deep).
			const mode = params.mode ?? (await resolveDefaultReviewMode(ctx.cwd, ctx.model, pi.getThinkingLevel()));

			const { model, thinkingLevel } = await resolveModelAndThinking(
				ctx.cwd,
				ctx.modelRegistry,
				ctx.model,
				pi.getThinkingLevel(),
				{ mode },
			);
			// Hard failures THROW: pi-agent-core only marks a tool result as an error
			// when execute() throws — a returned `isError` flag is ignored (see
			// executePreparedToolCall), so returning one would be reported to the model
			// as a SUCCESSFUL call.
			if (!model) {
				throw new Error("No model available for review.");
			}

			const range = `${since}..`;
			onUpdate?.({ content: [{ type: "text", text: `(reviewing ${range}...)` }], details: { range } });

			const outcome = await performReview({
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				model,
				thinkingLevel,
				modeOpt: mode,
				since,
				prompt,
				parentSessionFile: ctx.sessionManager?.getSessionFile(),
				signal,
				onProgress: (r, rng) => onUpdate?.({
					content: [{ type: "text", text: r.finalOutput || `(reviewing ${rng}...)` }],
					details: { range: rng, result: r },
				}),
			});

			// git log failed (or other pre-subagent error): hard failure -> throw.
			if (!outcome.ok) {
				throw new Error(outcome.error);
			}
			// Reviewer ran but produced nothing usable: surface as a thrown error too.
			if (outcome.failed && !outcome.reviewText && outcome.result.displayItems.length === 0) {
				throw new Error(`review failed: ${outcome.result.errorMessage || "unknown error"}`);
			}

			// Success, or an incomplete review WITH partial output: return the tagged
			// content (its embedded status="incomplete" marker tells the model it did
			// not finish). `isError` is set for forward-compat but not relied upon.
			return {
				content: [{ type: "text", text: outcome.contentText }],
				details: { range: outcome.range, result: outcome.result },
				isError: outcome.failed,
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as ReviewDetails | undefined;
			if (!d?.result) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
			}
			return renderResults([d.result], { expanded, label: `review ${d.range}` }, theme);
		},
	});
}
