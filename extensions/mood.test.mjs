/**
 * Headless tests for the mood extension.
 *
 * mood.ts has only type-only imports from pi, so it loads through jiti with no
 * aliases (same trick as nw.test.mjs). We cover the pure helpers plus the three
 * handlers via a mocked `pi`.
 *
 * Run:  node extensions/mood.test.mjs        (from the agent dir)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const piReal = execSync("readlink -f $(command -v pi)").toString().trim();
let cliJs = piReal;
try {
	const wrapper = readFileSync(piReal, "utf8");
	const m = wrapper.match(/exec node (\S+cli\.js)/);
	if (m) cliJs = m[1];
} catch {
	// piReal wasn't readable as text — assume it's cli.js itself.
}
const piRequire = createRequire(cliJs);
const jitiDir = dirname(piRequire.resolve("jiti/package.json"));
const { createJiti } = await import(`${jitiDir}/lib/jiti-static.mjs`);
const jiti = createJiti(import.meta.url);

const mood = await jiti.import(resolve(HERE, "mood.ts"));
const { extractMoods, latestMoodOf, stripMoods, latestMoodOfMessage } = mood;

// Register the three handlers against a mock pi; return them by event name.
function loadHandlers() {
	const handlers = {};
	const pi = { on: (name, fn) => (handlers[name] = fn) };
	mood.default(pi);
	return handlers;
}
function mockCtx({ hasUI = true } = {}) {
	const status = {};
	return {
		ctx: { hasUI, ui: { setStatus: (k, v) => (status[k] = v) } },
		status,
	};
}
function asst(content) {
	return { role: "assistant", content };
}
function text(t, extra = {}) {
	return { type: "text", text: t, ...extra };
}

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`ok - ${name}`);
	} catch (e) {
		failures++;
		console.error(`FAIL - ${name}\n`, e);
	}
}

// --- pure helpers ---------------------------------------------------------

test("extractMoods: collects all emoji in order, ignores empties", () => {
	assert.deepEqual(extractMoods("<mood>🙂</mood> hi <mood>😤</mood> bye <mood>🎉</mood>"), [
		"🙂",
		"😤",
		"🎉",
	]);
	assert.deepEqual(extractMoods("no tags here"), []);
	assert.deepEqual(extractMoods("<mood>  </mood>"), []); // whitespace-only ignored
});

test("latestMoodOf: returns the last tag, or undefined", () => {
	assert.equal(latestMoodOf("<mood>🙂</mood>...<mood>😎</mood>"), "😎");
	assert.equal(latestMoodOf("nothing"), undefined);
});

test("stripMoods: end-of-line and standalone tags leave clean text", () => {
	assert.equal(stripMoods("All tests pass. <mood>🎉</mood>"), "All tests pass.");
	assert.equal(stripMoods("Line one\n\n<mood>🤔</mood>\n\nLine two"), "Line one\n\nLine two");
});

test("stripMoods: inline tag consumes one adjacent space", () => {
	assert.equal(stripMoods("I feel <mood>😤</mood> stuck"), "I feel stuck");
});

test("stripMoods: preserves code indentation and returns unchanged text as-is", () => {
	const code = "Here:\n\n```py\ndef f():\n    return 1\n```";
	assert.equal(stripMoods(code), code);
	assert.equal(stripMoods("plain, no tags"), "plain, no tags");
});

test("latestMoodOfMessage: scans text and thinking parts in order", () => {
	const msg = asst([
		{ type: "thinking", thinking: "hmm <mood>🤔</mood>" },
		text("progress <mood>🙂</mood>"),
		text("done <mood>🎉</mood>"),
	]);
	assert.equal(latestMoodOfMessage(msg), "🎉");
	assert.equal(latestMoodOfMessage(asst([text("no mood")])), undefined);
});

// --- handlers -------------------------------------------------------------

test("before_agent_start: returns chained systemPrompt with the instruction", () => {
	const h = loadHandlers();
	const out = h.before_agent_start({ systemPrompt: "BASE" });
	assert.ok(out.systemPrompt.startsWith("BASE"));
	assert.match(out.systemPrompt, /<mood>X<\/mood>/);
	// Must not mutate in place — only the returned value carries the change.
});

test("message_update: pushes latest mood emoji to the footer", () => {
	const h = loadHandlers();
	const { ctx, status } = mockCtx();
	h.message_update({ message: asst([text("working <mood>🙂</mood> then <mood>😤</mood>")]) }, ctx);
	assert.equal(status.mood, "😤");
});

test("message_update: no-ops without UI or without a mood", () => {
	const h = loadHandlers();
	const noUI = mockCtx({ hasUI: false });
	h.message_update({ message: asst([text("<mood>🙂</mood>")]) }, noUI.ctx);
	assert.equal(noUI.status.mood, undefined);

	const { ctx, status } = mockCtx();
	h.message_update({ message: asst([text("plain text")]) }, ctx);
	assert.equal(status.mood, undefined);
});

test("message_end: strips tags, drops textSignature, keeps role & other blocks", () => {
	const h = loadHandlers();
	const { ctx, status } = mockCtx();
	const thinking = { type: "thinking", thinking: "reasoning", thinkingSignature: "sig-keep" };
	const msg = asst([thinking, text("All done. <mood>🎉</mood>", { textSignature: "sig-drop" })]);
	const out = h.message_end({ message: msg }, ctx);

	assert.equal(out.message.role, "assistant");
	// thinking block untouched (signature preserved for continuity)
	assert.deepEqual(out.message.content[0], thinking);
	// text stripped, signature dropped
	assert.deepEqual(out.message.content[1], { type: "text", text: "All done." });
	// footer still shows the final mood
	assert.equal(status.mood, "🎉");
});

test("message_end: returns undefined when there is nothing to strip", () => {
	const h = loadHandlers();
	const { ctx } = mockCtx();
	assert.equal(h.message_end({ message: asst([text("no tags")]) }, ctx), undefined);
});

if (failures) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall mood tests passed");
