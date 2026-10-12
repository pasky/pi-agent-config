// Run: node --test extensions/provider-system-prompt.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-ai": piAi } });
const { default: extension, foldSystemMessagesBeforeModelEpoch: fold } = await jiti.import(
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

test("folds prompt updates into the head after a model switch", () => {
	const out = fold(switched, CLAUDE);
	assert.equal(out.filter((m) => m.role === "system").length, 1);
	assert.equal(out[0].role, "system");
	assert.deepEqual(out[0].sections, { preamble: "claude preamble", cwd: "<cwd>/a</cwd>" });
	assert.deepEqual(getCurrentTools(out).map((t) => t.name), ["read", "mcp"]);
	assert.equal(getCurrentSystemPrompt(out), getCurrentSystemPrompt(switched));
	assert.deepEqual(out.slice(1), switched.filter((m) => m.role !== "system"));
});

test("head stays stable within the new model's epoch; later updates stay mid-conversation", () => {
	const later = sys({ cwd: "<cwd>/b</cwd>" });
	const messages = [...switched, asst("anthropic", "opus"), later, user("u3")];
	const out = fold(messages, CLAUDE);
	assert.deepEqual(out[0], fold(switched, CLAUDE)[0]);
	assert.equal(out.filter((m) => m.role === "system").length, 2);
	assert.equal(out.at(-2), later);
});

test("leaves single-model sessions untouched", () => {
	const messages = [sys({ preamble: "p" }), user("u1"), asst("anthropic", "opus"), sys({ cwd: "c" }), user("u2")];
	assert.equal(fold(messages, CLAUDE), undefined);
});

test("context_with_system hook applies the fold for the session model", async () => {
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: () => {} });
	const hook = handlers.get("context_with_system");
	assert.equal((await hook({ messages: switched }, { model: { provider: "anthropic", id: "opus" } })).messages.length, 4);
	assert.equal(await hook({ messages: switched }, { model: undefined }), undefined);
});
