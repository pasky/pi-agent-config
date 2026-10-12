// Run: node --test extensions/provider-system-prompt.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
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
const legacy = [
	sys({ preamble: DEFAULT_PREAMBLE, tools: "<tools/>", rules: "<rules/>", docs: "<docs/>", project_context: "<pc/>", cwd: "<cwd/>" }),
	user("u1"),
	asst("anthropic", "opus"),
	// pi's between-turn refresh in an extension-triggered run: back to its default prompt.
	sys({ preamble: DEFAULT_PREAMBLE, tools: "<tools/>", rules: "<rules/>", docs: "<docs/>", mood_indicator: null }),
	asst("anthropic", "opus"),
	sys({ preamble: DEFAULT_PREAMBLE, tools: "<tools/>" }, { toolsAdded: [tool("mcp")] }),
	sys({ preamble: DEFAULT_PREAMBLE, docs: "<docs/>" }),
	sys({ skills: "<skills/>" }),
	user("u2"),
];

test("enforces the provider preamble at the head and strips pi's default-only sections", () => {
	const out = enforce(legacy, "claude preamble");
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", project_context: "<pc/>", cwd: "<cwd/>" });
	assert.deepEqual(Object.keys(out[0].sections), ["preamble", "project_context", "cwd"]);
	assert.deepEqual(out.slice(1), [
		legacy[1],
		legacy[2],
		{ role: "system", content: "", timestamp: 1, sections: { mood_indicator: null } },
		legacy[4],
		{ role: "system", content: "", timestamp: 1, toolsAdded: [tool("mcp")] },
		legacy[7],
		legacy[8],
	]);
	// Stable: enforcing again changes nothing, so the head (and its cache) stays put.
	assert.equal(enforce(out, "claude preamble"), undefined);
});

test("leaves opaque (forced) prompts alone", () => {
	assert.equal(enforce([{ role: "system", content: "forced prompt", timestamp: 1 }, user("u")], "p"), undefined);
});

test("context_with_system hook folds, then enforces the provider prompt file", async () => {
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {} });
	const hook = handlers.get("context_with_system");
	const defaultPrompt = () => "You are an expert coding assistant operating inside pi.\n\n<docs>\n- Main documentation: /x/README.md\n</docs>";
	const providerFile = readFileSync(join(homedir(), ".pi/agent/system-prompts/anthropic.md"), "utf8");
	const head = (await hook({ messages: legacy }, { model: CLAUDE, getSystemPrompt: defaultPrompt })).messages[0];
	assert.ok(head.sections.preamble.startsWith(providerFile.split("\n")[0]));
	assert.equal(head.sections.docs, undefined);
	// An explicit prompt override (pi's base prompt lacks the default docs section): fold only.
	const overridden = { model: CLAUDE, getSystemPrompt: () => "custom system prompt" };
	assert.equal((await hook({ messages: switched }, overridden)).messages[0].sections.preamble, "claude preamble");
	assert.equal(await hook({ messages: legacy }, overridden), undefined);
	assert.equal(await hook({ messages: switched }, { model: undefined }), undefined);
	// Virtual selections route per request, so the epoch can't be derived from them.
	assert.equal(await hook({ messages: switched }, { model: { provider: "anthropic", id: "auto", api: "pi-virtual" } }), undefined);
});
