/**
 * /advisor — a persistent second model that reviews the main agent's work each
 * turn and injects concise advice inline. Port of oh-my-pi's advisor onto
 * upstream pi's extension API.
 *
 * Enable with `/advisor on` (persisted). The advisor model defaults to
 * openrouter/z-ai/glm-5.2 (override via an "advisor" entry in modes.json).
 *
 * Severity routing:
 *   nit      → injected non-interrupting at the next turn boundary
 *   concern  → steered into the agent (interrupting)
 *   blocker  → steered into the agent (interrupting)
 *
 * After an interrupting note, further concern/blocker notes are downgraded to
 * non-interrupting asides for `IMMUNE_TURNS` primary turns (anti-spam).
 *
 * An optional WATCHDOG.md in the cwd is appended to the advisor's system prompt
 * (advisor-only guidance: review priorities, project traps).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Agent, type AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { resolveModelAndThinking } from "../packages/pi-amplike/extensions/lib/mode-utils.js";

// ===========================================================================
// Advisor core — persistent second model that watches the main agent.
//
// Port of oh-my-pi's advisor onto upstream pi's public extension surface. The
// advisor is a long-lived `Agent` with its own model + read-only tools
// (read/grep/find) and one `advise` tool. It is fed the primary transcript one
// turn-delta at a time and may inject concise advice back. It is NOT an
// executor: it cannot edit, run commands, or change session state.
// ===========================================================================

export type AdvisorSeverity = "nit" | "concern" | "blocker";
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

/** Delivery channel for an advisory: a non-interrupting aside vs. an interrupting steer. */
export type AdvisorChannel = "nextTurn" | "steer";

// ---- advise tool (agent-core tool; lives only on the advisor agent) ----

const adviseSchema = Type.Object({
	note: Type.String({
		description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	}),
	severity: Type.Optional(
		Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
			description: "How strongly to weigh this. Omit for a plain nit.",
		}),
	),
});

const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
const rankOf = (s: AdvisorSeverity | undefined): number => SEVERITY_RANK[s ?? "nit"];
const dedupeKey = (note: string): string => note.trim().replace(/\s+/g, " ");
export const isInterrupting = (s: AdvisorSeverity | undefined): boolean => s === "concern" || s === "blocker";

/** Half-open immune-turn fence: true while `turnsCompleted` is before `immuneUntil`. */
export const isImmuneTurn = (turnsCompleted: number, immuneUntil: number): boolean => turnsCompleted < immuneUntil;

/**
 * Pure routing: which channel an advisory takes. `nit` (and omitted) always ride
 * the non-interrupting `nextTurn` aside. `concern`/`blocker` interrupt via `steer`
 * — unless an immune-turn cooldown is active, in which case they degrade to an
 * aside so a recent interrupt isn't immediately followed by another.
 */
export function deliveryChannelFor(severity: AdvisorSeverity | undefined, immune: boolean): AdvisorChannel {
	if (!isInterrupting(severity) || immune) return "nextTurn";
	return "steer";
}

/** Parse the hidden `/advisor test <nit|concern|blocker> <note>` test hook args. */
export function parseAdvisorTestArgs(args: string): { severity: AdvisorSeverity; note: string } | null {
	const m = args.trim().match(/^test\s+(nit|concern|blocker)\s+([\s\S]+)$/i);
	if (!m) return null;
	return { severity: m[1].toLowerCase() as AdvisorSeverity, note: m[2].trim() };
}

/**
 * The advise tool. Dedupes by normalized note text + severity rank: a repeat at
 * the same-or-lower severity is dropped, a real escalation (nit→concern→blocker)
 * passes through.
 */
export class AdviseTool {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description =
		"Send one concrete, terse piece of advice to the agent you are watching. Use sparingly; stay silent when nothing matters. Call it to head off likely-wrong or materially wasteful work.";
	readonly parameters = adviseSchema as any;
	#delivered = new Map<string, number>();

	constructor(private readonly onAdvice: (note: string, severity?: AdvisorSeverity) => void) {}

	resetDelivered(): void {
		this.#delivered.clear();
	}

	async execute(_id: string, args: { note: string; severity?: AdvisorSeverity }): Promise<AgentToolResult<unknown>> {
		const key = dedupeKey(args.note);
		const rank = rankOf(args.severity);
		const prev = this.#delivered.get(key) ?? 0;
		if (rank <= prev) {
			return { content: [{ type: "text", text: "Duplicate advice ignored." }], details: { ...args, dropped: true } };
		}
		this.#delivered.set(key, rank);
		this.onAdvice(args.note, args.severity);
		return { content: [{ type: "text", text: "Recorded." }], details: { ...args } };
	}
}

// ---- advisory rendering for the primary transcript ----

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";
const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render notes as the agent-facing message body: one `<advisory>` per note. */
export function formatAdvisoryContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map((n) => {
			const sev = n.severity ? ` severity="${n.severity}"` : "";
			return `<advisory${sev} guidance="${ADVISOR_GUIDANCE}">\n${escapeXml(n.note)}\n</advisory>`;
		})
		.join("\n");
}

// ---- transcript delta formatting (primary turn → markdown for the advisor) ----

function truncate(s: string, max = 4000): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
function textOf(content: Array<{ type: string; text?: string }>): string {
	return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("");
}

/** Format one primary turn (optionally preceded by the user prompt) as markdown. */
export function formatTurnDelta(opts: {
	userPrompt?: string;
	assistant?: AssistantMessage;
	toolResults?: ToolResultMessage[];
}): string {
	const parts: string[] = [];
	if (opts.userPrompt?.trim()) parts.push(`#### User\n\n${truncate(opts.userPrompt.trim(), 6000)}`);

	const a = opts.assistant;
	if (a) {
		const sub: string[] = [];
		for (const c of a.content) {
			if (c.type === "thinking" && c.thinking?.trim()) {
				sub.push(`<thinking>\n${truncate(c.thinking.trim())}\n</thinking>`);
			} else if (c.type === "text" && c.text?.trim()) {
				sub.push(truncate(c.text.trim()));
			} else if (c.type === "toolCall") {
				let args: string;
				try {
					args = JSON.stringify(c.arguments);
				} catch {
					args = "<unserializable>";
				}
				sub.push(`→ tool \`${c.name}\`(${truncate(args, 1200)})`);
			}
		}
		if (sub.length) parts.push(`#### Assistant\n\n${sub.join("\n\n")}`);
	}

	for (const tr of opts.toolResults ?? []) {
		const body = truncate(textOf(tr.content as Array<{ type: string; text?: string }>), 2500);
		parts.push(`#### Tool result: \`${tr.toolName}\`${tr.isError ? " (error)" : ""}\n\n${body || "(no text output)"}`);
	}
	return parts.join("\n\n");
}

// ---- build the persistent advisor Agent ----

function buildAdvisorAgent(opts: {
	cwd: string;
	model: Model<any>;
	thinkingLevel: string;
	systemPrompt: string;
	modelRegistry: any;
	adviseTool: AdviseTool;
}): Agent {
	const readOnly = createReadOnlyTools(opts.cwd);
	const thinkingLevel = opts.model.reasoning ? (opts.thinkingLevel as any) : ("off" as any);
	return new Agent({
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: opts.model,
			thinkingLevel,
			tools: [opts.adviseTool, ...readOnly] as any,
		},
		convertToLlm,
		// Use the bundled default streamFn (pi-agent-core's own streamSimple); we
		// only supply auth. The `@mariozechner/pi-ai` extension surface does not
		// expose streamSimple, so a custom streamFn is not an option here.
		getApiKey: (provider: string) => opts.modelRegistry.getApiKeyForProvider(provider),
	});
}

// ---- AdvisorRuntime — drives the advisor agent off primary turn deltas ----

/**
 * Feeds the persistent advisor agent one delta per primary turn, serialized so
 * the agent is never prompted while already streaming. On context overflow (or
 * any history rewrite) the caller invokes `reset()`, which clears the advisor's
 * own context so the next delta replays fresh.
 */
class AdvisorRuntime {
	#pending: string[] = [];
	#busy = false;
	#backlog = 0;
	#failures = 0;
	#epoch = 0;
	disposed = false;

	constructor(
		private readonly agent: Agent,
		private readonly adviseTool: AdviseTool,
		private readonly retryDelayMs = 1000,
		private readonly onDebug?: (...a: unknown[]) => void,
	) {}

	get backlog(): number {
		return this.#backlog;
	}

	get usage(): { input: number; output: number; cost: number; contextTokens: number; contextPercent: number | null } {
		let input = 0;
		let output = 0;
		let cost = 0;
		let contextTokens = 0;
		for (const m of this.agent.state.messages) {
			if (m.role === "assistant" && (m as AssistantMessage).usage) {
				const u = (m as AssistantMessage).usage;
				input += u.input ?? 0;
				output += u.output ?? 0;
				cost += u.cost?.total ?? 0;
				// Latest request's input + cache reads ≈ current advisor context size.
				contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			}
		}
		const window = (this.agent.state.model as { contextWindow?: number } | undefined)?.contextWindow;
		const contextPercent = window ? Math.round((contextTokens / window) * 100) : null;
		return { input, output, cost, contextTokens, contextPercent };
	}

	/** Queue a rendered primary-turn delta for review. */
	push(deltaText: string): void {
		if (this.disposed || !deltaText.trim()) return;
		this.#pending.push(deltaText);
		this.#backlog++;
		void this.#drain();
	}

	/** Re-prime after a history rewrite (compaction / session switch / fork). */
	reset(): void {
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		this.#failures = 0;
		this.adviseTool.resetDelivered();
		try {
			this.agent.abort();
		} catch {}
		try {
			this.agent.reset();
		} catch {}
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#backlog = 0;
		try {
			this.agent.abort();
		} catch {}
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const batch = this.#pending.splice(0);
				const turns = batch.length;
				const epoch = this.#epoch;
				const prompt = batch.join("\n\n---\n\n");
				try {
					this.onDebug?.("prompting advisor agent, delta chars=", prompt.length);
					await this.agent.prompt(`### Session update\n\n${prompt}`);
					const last = this.agent.state.messages[this.agent.state.messages.length - 1] as AssistantMessage;
					this.onDebug?.("advisor turn done, stop=", last?.stopReason, "err=", last?.errorMessage ?? "-");
					this.#failures = 0;
					if (this.#epoch === epoch) this.#backlog = Math.max(0, this.#backlog - turns);
				} catch (e) {
					this.onDebug?.("advisor prompt threw", String(e));
					// A reset/dispose aborts the in-flight prompt; drop the stale batch.
					if (this.#epoch !== epoch) continue;
					this.#failures++;
					if (this.#failures >= 3) {
						this.#failures = 0;
						this.#backlog = Math.max(0, this.#backlog - turns);
					} else {
						this.#pending.unshift(...batch);
						await new Promise((r) => setTimeout(r, this.retryDelayMs));
					}
				}
			}
		} finally {
			this.#busy = false;
		}
	}
}

// ===========================================================================
// Extension wiring
// ===========================================================================

const ADVISORY_TYPE = "advisory";
const DEBUG = !!process.env.ADVISOR_DEBUG;
const dbg = (...a: unknown[]) => {
	if (DEBUG) console.error("[advisor]", ...a);
};
const IMMUNE_TURNS = 3;
const DEFAULT_ADVISOR_PROVIDER = "openrouter";
const DEFAULT_ADVISOR_MODEL = "z-ai/glm-5.2";
const DEFAULT_THINKING = "low";

function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
	return path.join(os.homedir(), ".pi", "agent");
}

const STATE_FILE = () => path.join(agentDir(), ".advisor-state.json");

function loadEnabled(): boolean {
	// Opt-out: enabled unless explicitly turned off (`/advisor off`).
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")).enabled !== false;
	} catch {
		return true;
	}
}
function saveEnabled(enabled: boolean): void {
	try {
		fs.writeFileSync(STATE_FILE(), JSON.stringify({ enabled }), "utf8");
	} catch {}
}

function loadSystemPrompt(cwd: string): string {
	let prompt = "";
	try {
		prompt = fs.readFileSync(path.join(agentDir(), "system-prompts", "advisor.md"), "utf8");
	} catch {
		prompt = "You are a peer reviewer watching a coding agent. Use the `advise` tool sparingly to flag concrete technical risk; stay silent otherwise.";
	}
	// Append WATCHDOG.md (advisor-only project guidance) if present in cwd.
	try {
		const wd = fs.readFileSync(path.join(cwd, "WATCHDOG.md"), "utf8").trim();
		if (wd) prompt += `\n\nEspecially pay attention to:\n<attention>\n${wd}\n</attention>`;
	} catch {}
	return prompt;
}

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();

	// Lazily-built advisor state, rebuilt when cwd/model changes or session resets.
	let runtime: AdvisorRuntime | undefined;
	let activeModelLabel: string | undefined;
	let builtForCwd: string | undefined;

	// Delta accumulation across the lifecycle.
	let pendingUserPrompt: string | undefined;

	// Interrupt anti-spam.
	let turnsCompleted = 0;
	let immuneUntil = 0;

	// ---- advice delivery into the primary session ----
	function deliverAdvice(note: string, severity?: AdvisorSeverity): void {
		const channel = deliveryChannelFor(severity, isImmuneTurn(turnsCompleted, immuneUntil));
		dbg("deliverAdvice", severity, "->", channel, JSON.stringify(note).slice(0, 120));
		const notes: AdvisorNote[] = [{ note, severity }];
		const content = formatAdvisoryContent(notes);
		const message = { customType: ADVISORY_TYPE, content, display: true, details: { notes } };

		if (channel === "steer") {
			immuneUntil = turnsCompleted + IMMUNE_TURNS;
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
		} else {
			pi.sendMessage(message, { deliverAs: "nextTurn" });
		}
	}

	function teardown(): void {
		runtime?.dispose();
		runtime = undefined;
		activeModelLabel = undefined;
		builtForCwd = undefined;
		pendingUserPrompt = undefined;
		turnsCompleted = 0;
		immuneUntil = 0;
	}

	// ---- build the advisor agent lazily (needs ctx for model/registry/cwd) ----
	async function ensureRuntime(ctx: {
		cwd: string;
		modelRegistry: any;
		model: any;
	}): Promise<AdvisorRuntime | undefined> {
		if (runtime && builtForCwd === ctx.cwd) return runtime;
		if (runtime && builtForCwd !== ctx.cwd) teardown();

		if (!ctx.model) return undefined;

		// Resolve advisor model: modes.json "advisor" first, else the default.
		let model: any;
		let thinkingLevel = DEFAULT_THINKING;
		try {
			const resolved = await resolveModelAndThinking(ctx.cwd, ctx.modelRegistry, ctx.model, DEFAULT_THINKING, {
				mode: "advisor",
			});
			// resolveModelAndThinking falls back to the current model when "advisor"
			// mode is absent; detect that and use our hard default instead.
			const sameAsPrimary = resolved.model === ctx.model;
			model = sameAsPrimary ? undefined : resolved.model;
			thinkingLevel = resolved.thinkingLevel || DEFAULT_THINKING;
		} catch {}
		if (!model) {
			model = ctx.modelRegistry.find(DEFAULT_ADVISOR_PROVIDER, DEFAULT_ADVISOR_MODEL);
		}
		if (!model) return undefined;

		const adviseTool = new AdviseTool(deliverAdvice);
		const agent = buildAdvisorAgent({
			cwd: ctx.cwd,
			model,
			thinkingLevel,
			systemPrompt: loadSystemPrompt(ctx.cwd),
			modelRegistry: ctx.modelRegistry,
			adviseTool,
		});
		runtime = new AdvisorRuntime(agent, adviseTool, 1000, dbg);
		activeModelLabel = `${model.provider}/${model.id}`;
		builtForCwd = ctx.cwd;
		dbg("built advisor runtime, model=", activeModelLabel);
		return runtime;
	}

	// ---- event wiring ----

	// Capture the user prompt so it rides the next turn delta to the advisor.
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		pendingUserPrompt = event.prompt;
	});

	// One delta per primary turn (assistant message + its tool results).
	pi.on("turn_end", async (event, ctx) => {
		turnsCompleted++;
		// Test seam: skip live model review (keeps turn counting + the /advisor test
		// delivery path) so delivery/interrupt/immune behavior can be tested in the
		// pi harness without the nondeterministic advisor model.
		if (!enabled || process.env.ADVISOR_NO_REVIEW) return;
		const rt = await ensureRuntime(ctx as any);
		dbg("turn_end", "enabled=", enabled, "runtime=", !!rt, "model=", activeModelLabel);
		if (!rt) return;

		const delta = formatTurnDelta({
			userPrompt: pendingUserPrompt,
			assistant: event.message as AssistantMessage,
			toolResults: event.toolResults as ToolResultMessage[],
		});
		pendingUserPrompt = undefined;
		rt.push(delta);
	});

	// Re-prime the advisor when the primary transcript is rewritten.
	pi.on("session_compact", () => runtime?.reset());
	pi.on("session_start", (event) => {
		// new/resume/fork replace history; a plain startup/reload keeps it.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			if (runtime) runtime.reset();
			pendingUserPrompt = undefined;
			turnsCompleted = 0;
			immuneUntil = 0;
		}
	});

	pi.on("session_shutdown", () => teardown());

	// ---- advisory card rendering ----
	pi.registerMessageRenderer<{ notes: AdvisorNote[] }>(ADVISORY_TYPE, (message, _options, theme) => {
		const notes = message.details?.notes;
		if (!notes?.length) return undefined;
		const container = new Container();
		for (const n of notes) {
			const color = n.severity === "blocker" ? "error" : n.severity === "concern" ? "warning" : "dim";
			const tag = (n.severity ?? "nit").toUpperCase();
			container.addChild(new Text(`${theme.fg(color, `◆ advisor [${tag}]`)} ${theme.fg("muted", n.note)}`, 1, 0));
		}
		return container;
	});

	// ---- /advisor command ----
	pi.registerCommand("advisor", {
		description: "Toggle/inspect the advisor (a second model that reviews each turn). Usage: /advisor [on|off|status]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "status" || arg === "") {
				const state = enabled ? "enabled" : "disabled";
				if (!enabled) {
					ctx.ui.notify(`advisor ${state}`, "info");
					return;
				}
				const rt = await ensureRuntime(ctx as any);
				if (!rt) {
					ctx.ui.notify(`advisor enabled but no advisor model is available`, "warning");
					return;
				}
				const u = rt.usage;
				const ctxStr = u.contextPercent !== null ? `${u.contextPercent}% (${u.contextTokens} tok)` : `${u.contextTokens} tok`;
				ctx.ui.notify(
					`advisor ${state} — model ${activeModelLabel}, backlog ${rt.backlog}, ` +
						`tokens ${u.input}in/${u.output}out, cost $${u.cost.toFixed(4)}, ctx ${ctxStr}`,
					"info",
				);
				return;
			}

			if (arg === "on") {
				enabled = true;
				saveEnabled(true);
				const rt = await ensureRuntime(ctx as any);
				ctx.ui.notify(rt ? `advisor on — ${activeModelLabel}` : `advisor on, but no advisor model available`, rt ? "info" : "warning");
				return;
			}
			if (arg === "off") {
				enabled = false;
				saveEnabled(false);
				teardown();
				ctx.ui.notify("advisor off", "info");
				return;
			}

			// Hidden test hook: `/advisor test <nit|concern|blocker> <note>` drives the
			// real deliverAdvice routing without depending on the advisor model's
			// severity choice. Used by the RPC delivery tests.
			if (arg.startsWith("test")) {
				const parsed = parseAdvisorTestArgs(args);
				if (!parsed) {
					ctx.ui.notify("usage: /advisor test <nit|concern|blocker> <note>", "warning");
					return;
				}
				deliverAdvice(parsed.note, parsed.severity);
				return;
			}

			ctx.ui.notify("usage: /advisor [on|off|status]", "warning");
		},
	});
}
