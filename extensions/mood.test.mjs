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
const { extractMoods, latestMoodOf, styleMoods, latestMoodOfMessage, latestMoodForStatus } = mood;
const { buildSystemPrompt, buildSystemPromptSections } = await jiti.import(
	resolve(dirname(cliJs), "core/system-prompt.js"),
);
const { ExtensionRunner } = await jiti.import(resolve(dirname(cliJs), "core/extensions/runner.js"));

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

test("styleMoods: complete tags become italic bracketed markers", () => {
	assert.equal(styleMoods("All tests pass. <mood>🎉</mood>"), "All tests pass. *[🎉]*");
	assert.equal(styleMoods("a <mood>🙂</mood> b <mood>😤</mood>"), "a *[🙂]* b *[😤]*");
});

test("styleMoods: live mode hides a half-streamed trailing tag", () => {
	assert.equal(styleMoods("working <mood>😤", true), "working "); // opened, not closed
	assert.equal(styleMoods("working <mood>", true), "working ");
	assert.equal(styleMoods("done <moo", true), "done "); // partial open fragment
	assert.equal(styleMoods("done <", true), "done ");
	// a completed earlier tag survives while the trailing one is hidden
	assert.equal(styleMoods("<mood>🙂</mood> then <mo", true), "*[🙂]* then ");
});

test("styleMoods: non-live keeps a real '<' in content as-is", () => {
	assert.equal(styleMoods("if a < b then"), "if a < b then");
});

test("styleMoods: a standalone/last mood paragraph attaches to the preceding one", () => {
	assert.equal(styleMoods("First para.\n\n<mood>🎉</mood>"), "First para. *[🎉]*");
	assert.equal(styleMoods("A\n\n<mood>🤔</mood>\n\nB"), "A *[🤔]*\n\nB");
});

test("styleMoods: a leading mood paragraph attaches to the following one", () => {
	assert.equal(styleMoods("<mood>🙂</mood>\n\nHere we go."), "*[🙂]* Here we go.");
	assert.equal(styleMoods("\n<mood>🙂</mood>\n\nGo."), "*[🙂]* Go.");
});

test("styleMoods: preserves code indentation and returns unchanged text as-is", () => {
	const code = "Here:\n\n```py\ndef f():\n    return 1\n```";
	assert.equal(styleMoods(code), code);
	assert.equal(styleMoods("plain, no tags"), "plain, no tags");
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

test("latestMoodForStatus: recovers the mood from ALREADY-STYLED content", () => {
	// Regression for the status-vs-text bug: by the time the status reads the
	// message, message_update has usually rewritten the raw <mood> tags to *[X]*.
	// A raw-only reader returned undefined -> setStatus never fired -> blank/stale
	// pin. latestMoodForStatus must recover the latest mood from styled markers.
	const styled = asst([
		{ type: "thinking", thinking: "reasoning, no mood" },
		text("intro *[🧪]* middle *[🤨]* end *[🫡]*"),
	]);
	assert.equal(latestMoodOfMessage(styled), undefined); // raw-only reader is blind to styled markers
	assert.equal(latestMoodForStatus(styled), "🫡"); // tolerant reader recovers it
	// Still works on raw tags, and on a mix (last marker wins in document order).
	assert.equal(latestMoodForStatus(asst([text("a <mood>😀</mood> b <mood>😎</mood>")])), "😎");
	assert.equal(latestMoodForStatus(asst([text("raw <mood>😀</mood> then styled *[🫡]*")])), "🫡");
	assert.equal(latestMoodForStatus(asst([text("nothing here")])), undefined);
});

// --- handlers -------------------------------------------------------------

test("before_agent_start: adds an idempotent section without forcing the prompt", () => {
	const h = loadHandlers();
	const systemPromptOptions = { customPrompt: "BASE", sections: { other: "KEEP" } };
	const event = { systemPrompt: "BASE", systemPromptOptions };
	assert.equal(h.before_agent_start(event), undefined);
	assert.match(systemPromptOptions.sections.mood_indicator, /<mood>X<\/mood>/);
	assert.equal(systemPromptOptions.sections.other, "KEEP");
	assert.equal(systemPromptOptions.customPrompt, "BASE");
	assert.equal(systemPromptOptions.forceSystemPrompt, undefined);
	const first = systemPromptOptions.sections.mood_indicator;
	h.before_agent_start(event);
	assert.equal(systemPromptOptions.sections.mood_indicator, first);
});

// Exercise the installed runner: returning systemPrompt sets forceSystemPrompt,
// which used to hide a later provider customPrompt edit from the actual request.
for (const providerFirst of [false, true]) {
	const moodHandler = loadHandlers().before_agent_start;
	const providerHandler = (event) => {
		event.systemPromptOptions.customPrompt = "PROVIDER PREAMBLE";
	};
	const handlers = providerFirst ? [providerHandler, moodHandler] : [moodHandler, providerHandler];
	const runner = {
		extensions: handlers.map((handler, index) => ({
			path: `test-extension-${index}`,
			handlers: new Map([["before_agent_start", [handler]]]),
		})),
		createContext: () => ({}),
		assertActive() {},
		emitError(error) { throw new Error(error.error); },
	};
	const { systemPromptOptions } = await ExtensionRunner.prototype.emitBeforeAgentStart.call(
		runner, "hello", undefined, { cwd: "/test", sections: { other: "KEEP" } },
	);
	test(`before_agent_start: provider ${providerFirst ? "before" : "after"} mood reaches the request`, () => {
		const effective = buildSystemPrompt(systemPromptOptions);
		const recorded = Object.values(buildSystemPromptSections(systemPromptOptions)).join("\n\n");
		assert.equal(effective, recorded);
		assert.equal(systemPromptOptions.forceSystemPrompt, undefined);
		assert.ok(effective.startsWith("PROVIDER PREAMBLE"));
		assert.match(effective, /<mood_indicator>\n## Mood indicator/);
		assert.match(effective, /<other>\nKEEP\n<\/other>/);
		assert.match(effective, /<cwd>\n\/test\n<\/cwd>/);
	});
}

test("message_update: footer gets latest mood; display content is styled", () => {
	const h = loadHandlers();
	const { ctx, status } = mockCtx();
	const msg = asst([text("working <mood>🙂</mood> then <mood>😤</mood>")]);
	h.message_update({ message: msg }, ctx);
	assert.equal(status.mood, "😤"); // read from raw, before styling
	assert.equal(msg.content[0].text, "working *[🙂]* then *[😤]*"); // display copy rewritten
});

test("message_update: hides a half-streamed trailing tag in the display copy", () => {
	const h = loadHandlers();
	const { ctx } = mockCtx();
	const msg = asst([text("progress <mood>😤")]);
	h.message_update({ message: msg }, ctx);
	assert.equal(msg.content[0].text, "progress ");
});

test("message_update: no-ops footer without UI or without a mood", () => {
	const h = loadHandlers();
	const noUI = mockCtx({ hasUI: false });
	h.message_update({ message: asst([text("<mood>🙂</mood>")]) }, noUI.ctx);
	assert.equal(noUI.status.mood, undefined);

	const { ctx, status } = mockCtx();
	h.message_update({ message: asst([text("plain text")]) }, ctx);
	assert.equal(status.mood, undefined);
});

test("message_end: styles tags, drops textSignature, keeps role & other blocks", () => {
	const h = loadHandlers();
	const { ctx, status } = mockCtx();
	const thinking = { type: "thinking", thinking: "reasoning", thinkingSignature: "sig-keep" };
	const msg = asst([thinking, text("All done. <mood>🎉</mood>", { textSignature: "sig-drop" })]);
	const out = h.message_end({ message: msg }, ctx);

	assert.equal(out.message.role, "assistant");
	// thinking block untouched (signature preserved for continuity)
	assert.deepEqual(out.message.content[0], thinking);
	// text styled, signature dropped
	assert.deepEqual(out.message.content[1], { type: "text", text: "All done. *[🎉]*" });
	// footer still shows the final mood
	assert.equal(status.mood, "🎉");
});

test("message_end: returns undefined when there is nothing to style", () => {
	const h = loadHandlers();
	const { ctx } = mockCtx();
	assert.equal(h.message_end({ message: asst([text("no tags")]) }, ctx), undefined);
});

if (failures) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall mood tests passed");
