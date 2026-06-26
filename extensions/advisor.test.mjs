/**
 * Tests for the /advisor extension (a persistent second model that reviews each
 * turn and injects advice). Mirrors review.test.mjs structure.
 *
 * Layers:
 *   1. pure logic        — routing, immune fence, arg parsing, advisory/​delta
 *                          formatting, AdviseTool dedup (no model/network/TUI)
 *   2. real loader       — the extension registers through pi's loader
 *   3. render path        — the advisory renderer shows notes by severity
 *   4. pi harness (E2E)  — drive a real `pi --mode rpc` and verify that delivery
 *                          actually interrupts/retriggers vs. stays quiet, and
 *                          that the immune-turn cooldown downgrades interrupts.
 *                          Gated behind ADVISOR_E2E=1 (needs anthropic auth +
 *                          network; spawns pi with ADVISOR_NO_REVIEW so the
 *                          advisor model never fires — only the deterministic
 *                          `/advisor test` delivery hook does).
 *
 * Run:  node extensions/advisor.test.mjs              (fast, offline)
 *       ADVISOR_E2E=1 node extensions/advisor.test.mjs (also the pi harness)
 */

import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const PI_BIN = execSync("command -v pi").toString().trim();
const DIST = dirname(execSync(`readlink -f ${PI_BIN}`).toString().trim());

const { createExtensionRuntime, loadExtensions } = await import(`${DIST}/core/extensions/loader.js`);
const { createEventBus } = await import(`${DIST}/core/event-bus.js`);
const { CustomMessageComponent } = await import(`${DIST}/modes/interactive/components/custom-message.js`);
const { initTheme } = await import(`${DIST}/modes/interactive/theme/theme.js`);

// advisor.ts has @mariozechner/* value imports; reach its exported pure helpers
// through jiti with the same aliases pi's extension loader uses.
const piRequire = createRequire(`${DIST}/index.js`);
const jitiDir = dirname(piRequire.resolve("jiti/package.json"));
const { createJiti } = await import(`${jitiDir}/lib/jiti-static.mjs`);
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
	typebox: resolve(DIST, "..", "node_modules", "typebox", "build", "index.mjs"),
};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: ALIAS });
const A = await jiti.import(resolve(AGENT_DIR, "extensions/advisor.ts"));

initTheme();

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ===========================================================================
// 1. pure logic
// ===========================================================================

test("isInterrupting: only concern/blocker interrupt", () => {
	assert.equal(A.isInterrupting(undefined), false);
	assert.equal(A.isInterrupting("nit"), false);
	assert.equal(A.isInterrupting("concern"), true);
	assert.equal(A.isInterrupting("blocker"), true);
});

test("isImmuneTurn: half-open fence", () => {
	assert.equal(A.isImmuneTurn(0, 0), false); // immuneUntil 0 ⇒ never immune
	assert.equal(A.isImmuneTurn(1, 3), true);
	assert.equal(A.isImmuneTurn(2, 3), true);
	assert.equal(A.isImmuneTurn(3, 3), false); // fence is exclusive
	assert.equal(A.isImmuneTurn(4, 3), false);
});

test("deliveryChannelFor: nit/omitted ride the non-interrupting aside", () => {
	assert.equal(A.deliveryChannelFor(undefined, false), "nextTurn");
	assert.equal(A.deliveryChannelFor("nit", false), "nextTurn");
	assert.equal(A.deliveryChannelFor("nit", true), "nextTurn");
});

test("deliveryChannelFor: concern/blocker steer when not immune", () => {
	assert.equal(A.deliveryChannelFor("concern", false), "steer");
	assert.equal(A.deliveryChannelFor("blocker", false), "steer");
});

test("deliveryChannelFor: immune cooldown downgrades interrupts to aside", () => {
	assert.equal(A.deliveryChannelFor("concern", true), "nextTurn");
	assert.equal(A.deliveryChannelFor("blocker", true), "nextTurn");
});

test("parseAdvisorTestArgs: valid severities + multiword note", () => {
	assert.deepEqual(A.parseAdvisorTestArgs("test nit be tidy"), { severity: "nit", note: "be tidy" });
	assert.deepEqual(A.parseAdvisorTestArgs("test  concern   wrong path here"), {
		severity: "concern",
		note: "wrong path here",
	});
	assert.deepEqual(A.parseAdvisorTestArgs("test BLOCKER STOP NOW"), { severity: "blocker", note: "STOP NOW" });
});

test("parseAdvisorTestArgs: rejects bad input", () => {
	assert.equal(A.parseAdvisorTestArgs("test"), null);
	assert.equal(A.parseAdvisorTestArgs("test nit"), null); // no note
	assert.equal(A.parseAdvisorTestArgs("test bogus hi"), null); // bad severity
	assert.equal(A.parseAdvisorTestArgs("status"), null);
});

test("formatAdvisoryContent: wraps with severity + guidance, escapes XML", () => {
	const c = A.formatAdvisoryContent([{ note: "use <T> & stuff", severity: "concern" }]);
	assert.match(c, /<advisory severity="concern" guidance="weigh, don't blindly obey">/);
	assert.match(c, /use &lt;T&gt; &amp; stuff/);
	assert.match(c, /<\/advisory>/);
});

test("formatAdvisoryContent: omits severity attr when absent (plain nit)", () => {
	const c = A.formatAdvisoryContent([{ note: "tidy up" }]);
	assert.doesNotMatch(c, /severity=/);
	assert.match(c, /<advisory guidance=/);
});

test("formatTurnDelta: includes user, thinking, text, tool call + result", () => {
	const md = A.formatTurnDelta({
		userPrompt: "do the thing",
		assistant: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me think" },
				{ type: "text", text: "here is my plan" },
				{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.js" } },
			],
			usage: {},
			stopReason: "toolUse",
			timestamp: 1,
		},
		toolResults: [{ role: "toolResult", toolCallId: "1", toolName: "write", content: [{ type: "text", text: "wrote a.js" }], isError: false, timestamp: 2 }],
	});
	assert.match(md, /#### User\n\ndo the thing/);
	assert.match(md, /<thinking>\nlet me think\n<\/thinking>/);
	assert.match(md, /here is my plan/);
	assert.match(md, /→ tool `write`\(\{"path":"a\.js"\}\)/);
	assert.match(md, /#### Tool result: `write`\n\nwrote a\.js/);
});

test("formatTurnDelta: marks tool errors", () => {
	const md = A.formatTurnDelta({
		toolResults: [{ role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 2 }],
	});
	assert.match(md, /#### Tool result: `bash` \(error\)/);
});

test("formatTurnDelta: empty turn ⇒ empty string", () => {
	assert.equal(A.formatTurnDelta({}), "");
});

test("AdviseTool: records, dedups, and escalates by severity rank", async () => {
	const calls = [];
	const tool = new A.AdviseTool((note, severity) => calls.push({ note, severity }));

	const r1 = await tool.execute("c1", { note: "guard empty array", severity: "nit" });
	assert.equal(calls.length, 1);
	assert.match(r1.content[0].text, /Recorded/);

	// exact duplicate (same text, same severity) is dropped
	const r2 = await tool.execute("c2", { note: "guard empty array", severity: "nit" });
	assert.equal(calls.length, 1);
	assert.match(r2.content[0].text, /Duplicate/);

	// whitespace-normalized duplicate also dropped
	await tool.execute("c3", { note: "guard   empty\narray", severity: "nit" });
	assert.equal(calls.length, 1);

	// escalation to a higher severity passes through
	await tool.execute("c4", { note: "guard empty array", severity: "concern" });
	assert.equal(calls.length, 2);
	assert.equal(calls[1].severity, "concern");

	// de-escalation back down is dropped
	await tool.execute("c5", { note: "guard empty array", severity: "nit" });
	assert.equal(calls.length, 2);

	// reset clears memory ⇒ same note can be raised again
	tool.resetDelivered();
	await tool.execute("c6", { note: "guard empty array", severity: "nit" });
	assert.equal(calls.length, 3);
});

// ===========================================================================
// 2. real loader
// ===========================================================================

async function loadAdvisorExtension() {
	const runtime = createExtensionRuntime();
	const res = await loadExtensions(["extensions/advisor.ts"], AGENT_DIR, createEventBus(), runtime);
	assert.deepEqual(res.errors, [], "extension should load without errors");
	return res.extensions[0];
}

test("extension loads + registers /advisor command and advisory renderer", async () => {
	const ext = await loadAdvisorExtension();
	assert.ok(ext.commands.has("advisor"), "registers /advisor");
	assert.ok(ext.messageRenderers.has("advisory"), "registers advisory renderer");
});

// ===========================================================================
// 3. render path
// ===========================================================================

async function renderAdvisory(notes) {
	const ext = await loadAdvisorExtension();
	const renderer = ext.messageRenderers.get("advisory");
	const message = {
		role: "custom",
		customType: "advisory",
		content: [{ type: "text", text: "x" }],
		display: true,
		details: { notes },
		timestamp: Date.now(),
	};
	const comp = new CustomMessageComponent(message, renderer);
	comp.setExpanded(false);
	return strip(comp.render(100).join("\n"));
}

test("render: advisory card shows severity tag + note text", async () => {
	const text = await renderAdvisory([{ note: "this divides by zero on empty input", severity: "blocker" }]);
	assert.match(text, /advisor/i);
	assert.match(text, /BLOCKER/);
	assert.match(text, /divides by zero/);
});

test("render: plain nit shows NIT tag", async () => {
	const text = await renderAdvisory([{ note: "tidy this up" }]);
	assert.match(text, /NIT/);
	assert.match(text, /tidy this up/);
});

// ===========================================================================
// 4. pi harness (E2E) — interrupting / retriggering / immune cooldown
// ===========================================================================

class RpcPi {
	constructor() {
		const cwd = mkdtempSync(join(tmpdir(), "advisor-e2e-"));
		execSync("git init -q", { cwd });
		writeFileSync(join(cwd, "README.md"), "# test\n");
		this.cwd = cwd;
		this.events = [];
		this.agentStarts = 0;
		this.agentEnds = 0;
		this.proc = spawn(
			PI_BIN,
			["--mode", "rpc", "--model", "anthropic/claude-haiku-4-5", "--session-dir", join(cwd, ".sessions")],
			{ cwd, env: { ...process.env, ADVISOR_NO_REVIEW: "1" } },
		);
		this.proc.stderr.on("data", () => {});
		let buffer = "";
		const decoder = new StringDecoder("utf8");
		this.proc.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			for (;;) {
				const i = buffer.indexOf("\n");
				if (i === -1) break;
				let line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				let ev;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				this.events.push(ev);
				if (ev.type === "agent_start") this.agentStarts++;
				if (ev.type === "agent_end") this.agentEnds++;
			}
		});
	}
	send(cmd) {
		this.proc.stdin.write(JSON.stringify(cmd) + "\n");
	}
	prompt(message) {
		this.send({ type: "prompt", message });
	}
	async sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}
	async waitFor(pred, timeoutMs, label) {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (pred()) return true;
			await this.sleep(150);
		}
		throw new Error(`timeout waiting for ${label}`);
	}
	async getMessages() {
		const id = "gm-" + Math.random().toString(36).slice(2);
		const before = this.events.length;
		this.send({ id, type: "get_messages" });
		await this.waitFor(
			() => this.events.slice(before).some((e) => e.type === "response" && e.id === id),
			5000,
			"get_messages response",
		);
		const resp = this.events.slice(before).find((e) => e.type === "response" && e.id === id);
		return resp?.data?.messages || [];
	}
	kill() {
		try {
			this.proc.kill("SIGTERM");
		} catch {}
	}
}

if (process.env.ADVISOR_E2E) {
	test("E2E: nit is non-interrupting, then rides the next turn", async () => {
		const pi = new RpcPi();
		try {
			await pi.sleep(2500);
			const before = pi.agentStarts;
			pi.prompt("/advisor test nit NITSENTINEL tidy later");
			await pi.sleep(4000);
			assert.equal(pi.agentStarts, before, "nit must NOT trigger an agent turn");
			assert.ok(!JSON.stringify(await pi.getMessages()).includes("NITSENTINEL"), "nit stays pending while idle");
			// a real turn flushes the pending nextTurn advisory into the transcript
			pi.prompt("reply with the single word: hi");
			await pi.waitFor(() => pi.agentEnds >= 1, 60000, "flush turn end");
			assert.ok(JSON.stringify(await pi.getMessages()).includes("NITSENTINEL"), "nit advisory rides the next turn into the transcript");
		} finally {
			pi.kill();
		}
	});

	test("E2E: blocker interrupts/retriggers a turn and lands in transcript", async () => {
		const pi = new RpcPi();
		try {
			await pi.sleep(2500);
			const before = pi.agentStarts;
			pi.prompt("/advisor test blocker BLOCKSENTINEL stop and reconsider");
			await pi.waitFor(() => pi.agentStarts > before, 30000, "blocker-triggered agent_start");
			await pi.waitFor(() => pi.agentEnds >= 1, 60000, "triggered turn agent_end");
			const adv = (await pi.getMessages()).find(
				(m) => m.role === "custom" && m.customType === "advisory" && JSON.stringify(m).includes("BLOCKSENTINEL"),
			);
			assert.ok(adv, "blocker advisory should be in the transcript as an advisory custom message");
			assert.equal(adv.details.notes[0].severity, "blocker", "advisory carries blocker severity");
		} finally {
			pi.kill();
		}
	});

	test("E2E: concern interrupts when not immune", async () => {
		const pi = new RpcPi();
		try {
			await pi.sleep(2500);
			const before = pi.agentStarts;
			pi.prompt("/advisor test concern CONCERNSENTINEL fragile approach");
			await pi.waitFor(() => pi.agentStarts > before, 30000, "concern-triggered agent_start");
			assert.ok(pi.agentStarts > before, "concern must trigger a turn when not immune");
		} finally {
			pi.kill();
		}
	});

	test("E2E: immune cooldown downgrades a concern right after a blocker", async () => {
		const pi = new RpcPi();
		try {
			await pi.sleep(2500);
			// blocker triggers a turn and arms the immune fence (3 turns)
			const b0 = pi.agentStarts;
			pi.prompt("/advisor test blocker IMMUNEBLOCK arm the fence");
			await pi.waitFor(() => pi.agentStarts > b0, 30000, "blocker agent_start");
			await pi.waitFor(() => pi.agentEnds >= 1, 60000, "blocker turn end");
			await pi.sleep(1000);
			// a concern within the immune window must NOT trigger another turn
			const c0 = pi.agentStarts;
			pi.prompt("/advisor test concern IMMUNECONCERN should be downgraded");
			await pi.sleep(5000);
			assert.equal(pi.agentStarts, c0, "concern during immune cooldown must be downgraded to a non-interrupting aside");
			// flush: the downgraded (nextTurn) concern rides the following real turn
			pi.prompt("reply with the single word: ok");
			await pi.waitFor(() => pi.agentEnds >= 2, 60000, "flush turn end");
			assert.ok(JSON.stringify(await pi.getMessages()).includes("IMMUNECONCERN"), "downgraded concern rides the next turn into the transcript");
		} finally {
			pi.kill();
		}
	});
} else {
	test("E2E (skipped: set ADVISOR_E2E=1 to run the pi harness)", () => {});
}

// ===========================================================================
// runner
// ===========================================================================

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
