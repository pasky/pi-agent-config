// Run: node --test extensions/provider-system-prompt.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

// Resolve dependencies from the installed pi, including the local shell wrapper.
const piPath = execSync("readlink -f $(command -v pi)").toString().trim();
const cli = readFileSync(piPath, "utf8").match(/exec node (\S+cli\.js)/)?.[1] ?? piPath;
const require = createRequire(cli);
const { createJiti } = await import(pathToFileURL(join(dirname(require.resolve("jiti/package.json")), "lib/jiti-static.mjs")));
// Resolve @earendil-works/pi-ai the same way pi does for extensions.
const piAiDir = require.resolve.paths("@earendil-works/pi-ai")
	.map((dir) => join(dir, "@earendil-works/pi-ai"))
	.find((dir) => existsSync(dir));
const piAi = pathToFileURL(join(piAiDir, "dist/compat.js")).href;
// And @earendil-works/pi-coding-agent as the installed pi itself (cli.js sits next to index.js).
const piCodingAgent = pathToFileURL(join(dirname(cli), "index.js")).href;
// Isolated provider prompt files: the extension reads ~/.pi/agent/system-prompts.
const fakeHome = mkdtempSync(join(tmpdir(), "psp-test-"));
mkdirSync(join(fakeHome, ".pi/agent/system-prompts"), { recursive: true });
writeFileSync(join(fakeHome, ".pi/agent/system-prompts/anthropic.md"), "claude preamble, docs at @PIROOT@/docs\n");
writeFileSync(join(fakeHome, ".pi/agent/system-prompts/openai-codex.md"), "openai preamble\n");
process.env.HOME = fakeHome;
after(() => rmSync(fakeHome, { recursive: true }));
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-ai": piAi, "@earendil-works/pi-coding-agent": piCodingAgent },
});
const { default: extension, foldSystemMessagesBeforeModelEpoch: fold, enforceProviderPreamble: enforce } = await jiti.import(
	new URL("./provider-system-prompt.ts", import.meta.url).pathname,
);
const { getCurrentSystemPrompt, getCurrentTools } = await import(piAi);

const tool = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const sys = (sections, extra = {}) => ({ role: "system", content: "", sections, timestamp: 1, ...extra });
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const asst = (provider, model) => ({ role: "assistant", content: [], provider, model, api: "x", timestamp: 1 });
const CLAUDE = { provider: "anthropic", id: "opus" };

const switched = [
	sys({ preamble: "openai preamble", cwd: "<cwd>/a</cwd>" }, { toolsAdded: [tool("read")] }),
	user("u1"),
	asst("openai-codex", "gpt"),
	sys({ preamble: "claude preamble" }, { toolsAdded: [tool("mcp")] }),
	user("u2"),
];

test("folds prompt text into the head after a model switch, keeping tool deltas in place", () => {
	const out = fold(switched, CLAUDE);
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", cwd: "<cwd>/a</cwd>" });
	assert.deepEqual(out[0].toolsAdded, [tool("read")]);
	assert.deepEqual(out[3], { role: "system", content: "", timestamp: 1, toolsAdded: [tool("mcp")] });
	assert.equal(getCurrentSystemPrompt(out), getCurrentSystemPrompt(switched));
	assert.deepEqual(getCurrentTools(out), getCurrentTools(switched));
	assert.deepEqual(out.filter((m) => m.role !== "system"), switched.filter((m) => m.role !== "system"));
});

test("drops text-only updates and keeps tool removals after the calls they follow", () => {
	const call = { ...asst("openai-codex", "gpt"), content: [{ type: "toolCall", id: "c1", name: "old", arguments: {} }] };
	const messages = [
		sys({ preamble: "openai preamble" }),
		user("u1"),
		sys({ cwd: "<cwd>/a</cwd>" }, { toolsAdded: [tool("old")] }),
		call,
		sys({}, { toolsRemoved: [{ name: "old" }] }),
		sys({ preamble: "claude preamble" }),
		user("u2"),
	];
	const out = fold(messages, CLAUDE);
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", cwd: "<cwd>/a</cwd>" });
	assert.equal(out[0].toolsAdded, undefined);
	// "old" is still declared right before the call to it and removed right after.
	assert.deepEqual(out.slice(1), [
		messages[1],
		{ role: "system", content: "", timestamp: 1, toolsAdded: [tool("old")] },
		call,
		messages[4],
		messages[6],
	]);
});

test("head stays stable within the new model's epoch; later updates stay mid-conversation", () => {
	const later = sys({ cwd: "<cwd>/b</cwd>" });
	const messages = [...switched, asst("anthropic", "opus"), later, user("u3")];
	const out = fold(messages, CLAUDE);
	assert.deepEqual(out[0], fold(switched, CLAUDE)[0]);
	assert.equal(out.filter((m) => m.role === "system").length, 3);
	assert.equal(out.at(-2), later);
});

test("leaves single-model sessions untouched", () => {
	const messages = [sys({ preamble: "p" }), user("u1"), asst("anthropic", "opus"), sys({ cwd: "c" }), user("u2")];
	assert.equal(fold(messages, CLAUDE), undefined);
});

const DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi.";
const PROVIDERS = new Set(["claude preamble", "openai preamble"]);
const PI_DOCS = "<docs>\nPi documentation:\n- Main documentation: /pi/README.md\n</docs>";
const DEFAULTS = { tools: "<tools/>", rules: "<rules/>", docs: PI_DOCS };
const legacy = [
	sys({ preamble: DEFAULT_PREAMBLE, ...DEFAULTS, project_context: "<pc/>", cwd: "<cwd/>" }),
	user("u1"),
	asst("anthropic", "opus"),
	sys({ preamble: "claude preamble", tools: null, rules: null, docs: null, mood_indicator: "<mood/>" }),
	asst("anthropic", "opus"),
	// pi's between-turn refresh in an extension-triggered run: back to its default prompt.
	sys({ preamble: DEFAULT_PREAMBLE, ...DEFAULTS, mood_indicator: null }, { toolsAdded: [tool("mcp")] }),
	asst("anthropic", "opus"),
	sys({ tools: "<tools2/>" }),
	sys({ skills: "<skills/>" }),
	user("u2"),
];

test("enforces the provider preamble at the head and strips pi's default-only sections", () => {
	const out = enforce(legacy, "claude preamble", PROVIDERS);
	assert.deepEqual(Object.entries(out[0].sections), [["preamble", "claude preamble"], ["project_context", "<pc/>"], ["cwd", "<cwd/>"]]);
	assert.deepEqual(out.slice(1), [
		legacy[1],
		legacy[2],
		{ role: "system", content: "", timestamp: 1, sections: { tools: null, rules: null, docs: null, mood_indicator: "<mood/>" } },
		legacy[4],
		{ role: "system", content: "", timestamp: 1, sections: { mood_indicator: null }, toolsAdded: [tool("mcp")] },
		legacy[6],
		legacy[8],
		legacy[9],
	]);
	// Stable: enforcing again changes nothing, so the head (and its cache) stays put.
	assert.equal(enforce(out, "claude preamble", PROVIDERS), undefined);
	assert.deepEqual(enforce([...legacy, asst("anthropic", "opus"), sys({ cwd: "<cwd2/>" })], "claude preamble", PROVIDERS)[0], out[0]);
});

test("keeps an extension's own tools/rules/docs sections next to a provider prompt", () => {
	const messages = [sys({ preamble: "openai preamble", rules: "<ext rules/>" }), user("u"), sys({ docs: "<ext docs/>" })];
	const out = enforce(messages, "claude preamble", PROVIDERS);
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", rules: "<ext rules/>" });
	assert.equal(out[2], messages[2]);
});

test("retracts an extension's section that pi's default replaced, instead of resurrecting it", () => {
	const messages = [
		sys({ preamble: "claude preamble", rules: "<only for this run/>" }),
		user("u"),
		asst("anthropic", "opus"),
		sys({ preamble: DEFAULT_PREAMBLE, ...DEFAULTS }),
		user("u2"),
	];
	const out = enforce(messages, "claude preamble", PROVIDERS);
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", rules: "<only for this run/>" });
	assert.deepEqual(out[3].sections, { rules: null });
});

test("an edited provider prompt is not mistaken for pi's default", () => {
	// The session started with an older version of the prompt file, plus extension rules.
	const messages = [sys({ preamble: "claude preamble v1", rules: "<ext rules/>" }), user("u"), sys({ preamble: "claude preamble" })];
	const out = enforce(messages, "claude preamble", PROVIDERS);
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", rules: "<ext rules/>" });
	assert.equal(out.length, 2);
});

test("leaves explicit overrides and opaque prompts alone", () => {
	// An extension's own customPrompt with its own sections named like pi's default ones.
	const explicit = [sys({ preamble: "EXPLICIT OVERRIDE", tools: "<t/>", rules: "<r/>", docs: "<d/>" }), user("u")];
	assert.equal(enforce(explicit, "claude preamble", PROVIDERS), undefined);
	// Another custom prompt (SYSTEM.md, --system-prompt, another extension's customPrompt).
	const custom = [sys({ preamble: "my own prompt", cwd: "<cwd/>" }), user("u")];
	assert.equal(enforce(custom, "claude preamble", PROVIDERS), undefined);
	// ...even when copied from pi's default preamble text.
	assert.equal(enforce([sys({ preamble: DEFAULT_PREAMBLE, docs: "<docs/>" }), user("u")], "claude preamble", PROVIDERS), undefined);
	assert.equal(enforce([{ role: "system", content: "forced prompt", timestamp: 1 }, user("u")], "p", PROVIDERS), undefined);
});

test("context_with_system hook folds, then enforces the provider prompt file", async () => {
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {} });
	const hook = handlers.get("context_with_system");
	const head = (await hook({ messages: legacy }, { model: CLAUDE })).messages[0];
	const piRoot = dirname((await jiti.import("@earendil-works/pi-coding-agent")).getReadmePath());
	assert.equal(head.sections.preamble, `claude preamble, docs at ${piRoot}/docs`);
	assert.equal(head.sections.docs, undefined);
	assert.equal(await hook({ messages: switched }, { model: undefined }), undefined);
	// Virtual selections route per request, so the epoch can't be derived from them.
	assert.equal(await hook({ messages: switched }, { model: { provider: "anthropic", id: "auto", api: "pi-virtual" } }), undefined);
});

test("before_agent_start applies the provider prompt unless one is already set", async () => {
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {} });
	const hook = handlers.get("before_agent_start");
	const event = (customPrompt) => ({ systemPrompt: "", systemPromptOptions: { customPrompt } });
	const applied = event(undefined);
	await hook(applied, { model: { provider: "openai-codex" } });
	assert.equal(applied.systemPromptOptions.customPrompt, "openai preamble");
	const overridden = event("explicit");
	await hook(overridden, { model: { provider: "openai-codex" } });
	assert.equal(overridden.systemPromptOptions.customPrompt, "explicit");
});
