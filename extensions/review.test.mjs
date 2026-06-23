/**
 * Headless tests for the /review extension.
 *
 * Exercises the parts that are testable without a live model/network/TUI:
 *   - pure arg parsing + content tagging (review-lib.mjs)
 *   - the extension loads through pi's real loader (imports/aliases/registration)
 *   - convertToLlm collapses the review block into one tagged `user` message
 *   - the transcript render path (CustomMessageComponent + the registered
 *     renderer) shows the FULL review expanded — for success AND error results
 *     (the error case is the "does the block disappear?" regression guard)
 *
 * Run:  node extensions/review.test.mjs        (from the agent dir)
 *
 * Resolves pi's dist dir from the `pi` binary on PATH, so it survives npx cache
 * churn. Requires the @earendil-works pi build.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");

const DIST = dirname(execSync("readlink -f $(command -v pi)").toString().trim()); // .../dist

const { createExtensionRuntime, loadExtensions } = await import(`${DIST}/core/extensions/loader.js`);
const { createEventBus } = await import(`${DIST}/core/event-bus.js`);
const { CustomMessageComponent } = await import(`${DIST}/modes/interactive/components/custom-message.js`);
const { initTheme } = await import(`${DIST}/modes/interactive/theme/theme.js`);
const { convertToLlm } = await import(`${DIST}/core/messages.js`);

// review.ts has @mariozechner/* imports, so load it through jiti with the same
// aliases pi's extension loader uses, to reach its exported pure helpers.
const piRequire = createRequire(`${DIST}/index.js`);
const jitiDir = dirname(piRequire.resolve("jiti/package.json"));
const { createJiti } = await import(`${jitiDir}/lib/jiti-static.mjs`);
// Bundled packages declare only an `import` condition, so point aliases at the
// dist entry files directly (mirrors pi's own extension-loader alias map).
const pkgEntry = (pkg) => resolve(DIST, "..", "node_modules", "@earendil-works", pkg, "dist/index.js");
const ALIAS = {
	"@earendil-works/pi-coding-agent": `${DIST}/index.js`,
	"@mariozechner/pi-coding-agent": `${DIST}/index.js`,
	"@earendil-works/pi-agent-core": pkgEntry("pi-agent-core"),
	"@mariozechner/pi-agent-core": pkgEntry("pi-agent-core"),
	"@earendil-works/pi-tui": pkgEntry("pi-tui"),
	"@mariozechner/pi-tui": pkgEntry("pi-tui"),
	"@earendil-works/pi-ai": pkgEntry("pi-ai"),
	"@mariozechner/pi-ai": pkgEntry("pi-ai"),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: ALIAS });
const { parseReviewArgs, buildReviewContent } = await jiti.import(resolve(AGENT_DIR, "extensions/review.ts"));

initTheme();

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// --- pure logic -----------------------------------------------------------

test("parseReviewArgs: defaults", () => {
	assert.deepEqual(parseReviewArgs(""), {
		modeOpt: undefined,
		since: "HEAD~1",
		prompt: "review changes since HEAD~1 carefully - analyze, debate and challenge",
	});
});

test("parseReviewArgs: since only", () => {
	const r = parseReviewArgs("main");
	assert.equal(r.since, "main");
	assert.match(r.prompt, /since main/);
});

test("parseReviewArgs: since + prompt", () => {
	assert.deepEqual(parseReviewArgs("main focus on auth"), {
		modeOpt: undefined,
		since: "main",
		prompt: "focus on auth",
	});
});

test("parseReviewArgs: -mode + since + prompt", () => {
	assert.deepEqual(parseReviewArgs("-mode deep origin/dev be ruthless"), {
		modeOpt: "deep",
		since: "origin/dev",
		prompt: "be ruthless",
	});
});

test("parseReviewArgs: -mode only falls back to default since", () => {
	const r = parseReviewArgs("-mode rush");
	assert.equal(r.modeOpt, "rush");
	assert.equal(r.since, "HEAD~1");
});

test("buildReviewContent: tags reviewer + mode, success", () => {
	const c = buildReviewContent({
		reviewerModel: "anthropic/opus", mode: "deep", since: "main", range: "main..",
		prompt: "p", gitLog: "LOG", reviewText: "THE REVIEW",
	});
	assert.match(c, /reviewer="anthropic\/opus"/);
	assert.match(c, /mode="deep"/);
	assert.match(c, /since="main"/);
	assert.doesNotMatch(c, /status="incomplete"/);
	assert.match(c, /\nReview:\nTHE REVIEW\n/);
	assert.match(c, /LOG/);
});

test("buildReviewContent: error marks incomplete + keeps partial", () => {
	const c = buildReviewContent({
		reviewerModel: "x/y", since: "main", range: "main..",
		prompt: "p", gitLog: "LOG", reviewText: "PARTIAL", error: "529 overloaded",
	});
	assert.match(c, /status="incomplete"/);
	assert.match(c, /did NOT finish \(529 overloaded\)/);
	assert.match(c, /Review \(partial\):\nPARTIAL/);
});

test("buildReviewContent: omits mode attr when absent", () => {
	const c = buildReviewContent({
		reviewerModel: "x/y", since: "H", range: "H..", prompt: "p", gitLog: "L", reviewText: "R",
	});
	assert.doesNotMatch(c, /mode=/);
});

// --- real loader ----------------------------------------------------------

async function loadReviewExtension() {
	const runtime = createExtensionRuntime();
	const res = await loadExtensions(["extensions/review.ts"], AGENT_DIR, createEventBus(), runtime);
	assert.deepEqual(res.errors, [], "extension should load without errors");
	const ext = res.extensions[0];
	return ext;
}

test("extension loads + registers command and renderer", async () => {
	const ext = await loadReviewExtension();
	assert.ok(ext.commands.has("review"), "registers /review");
	assert.ok(ext.messageRenderers.has("review-result"), "registers renderer");
});

// --- model context view ---------------------------------------------------

test("convertToLlm: review block -> single tagged user message", () => {
	const content = buildReviewContent({
		reviewerModel: "anthropic/opus", mode: "deep", since: "main", range: "main..",
		prompt: "p", gitLog: "LOG", reviewText: "THE REVIEW",
	});
	const msgs = [
		{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "a", provider: "b", model: "c", usage: {}, stopReason: "stop", timestamp: 1 },
		{ role: "custom", customType: "review-result", content: [{ type: "text", text: content }], display: true, details: {}, timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "consider the review above" }], timestamp: 3 },
	];
	const llm = convertToLlm(msgs);
	assert.deepEqual(llm.map((m) => m.role), ["assistant", "user", "user"]);
	const reviewMsg = llm[1];
	const text = typeof reviewMsg.content === "string" ? reviewMsg.content : reviewMsg.content[0].text;
	assert.match(text, /<code-review reviewer="anthropic\/opus" mode="deep"/);
	assert.match(text, /THE REVIEW/);
});

// --- transcript render path -----------------------------------------------

function syntheticResult({ exitCode = 0, errorMessage, lines = 60 } = {}) {
	const body = Array.from({ length: lines }, (_, i) => (i === 0 ? "## Bottom line" : `review body line ${i}`));
	body.push("SENTINEL_LAST_LINE");
	const finalOutput = exitCode === 0 || lines > 0 ? body.join("\n") : "";
	return {
		task: "review",
		exitCode,
		errorMessage,
		displayItems: [{ type: "toolCall", name: "bash", args: { command: "ls docs" } }, { type: "text", text: finalOutput }],
		finalOutput,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 59000, turns: 21 },
		model: "openai-codex/gpt-5.5",
	};
}

async function renderBlock(result) {
	const ext = await loadReviewExtension();
	const renderer = ext.messageRenderers.get("review-result");
	const message = {
		role: "custom", customType: "review-result",
		content: [{ type: "text", text: "x" }], display: true,
		details: { range: "HEAD^^..", result }, timestamp: Date.now(),
	};
	const comp = new CustomMessageComponent(message, renderer);
	comp.setExpanded(false); // TUI default; renderer must still show full review
	return strip(comp.render(100).join("\n"));
}

test("render (success): full review, expanded, not truncated/collapsed", async () => {
	const text = await renderBlock(syntheticResult({ exitCode: 0 }));
	assert.ok(text.includes("SENTINEL_LAST_LINE"), "shows last review line (not truncated)");
	assert.ok(!/Ctrl\+O to expand/.test(text), "not the collapsed minibox");
	assert.ok(!/\+\d+ lines/.test(text), "no truncation marker");
	assert.ok(text.includes("ls docs"), "shows tool feed");
});

test("render (error): block still appears with error + partial output", async () => {
	const text = await renderBlock(syntheticResult({ exitCode: 1, errorMessage: "529 overloaded" }));
	assert.ok(text.includes("SENTINEL_LAST_LINE"), "keeps partial review output");
	assert.ok(/529 overloaded/.test(text), "shows the error message");
});

// --- runner ---------------------------------------------------------------

for (const [name, fn] of tests) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}\n       ${err.message}`);
	}
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
