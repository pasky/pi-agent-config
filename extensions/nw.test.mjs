/**
 * Headless tests for the /nw extension.
 *
 * nw.ts has only type-only imports from pi, so the module loads through jiti
 * with no aliases — we just need jiti itself, resolved from the installed `pi`
 * (whether `pi` is a symlink to dist/cli.js or a shell wrapper that execs it).
 *
 * Covers the pure, exported helpers that hold the tricky logic:
 *   - pickNextResetWindow: picks the soonest future reset; ignores past/missing
 *   - scheduleAt: fires near delays; does NOT misfire on >24.8d delays that
 *     would overflow setTimeout; chunks the first wait to <= 2^31-1 ms
 *   - preview: collapses whitespace, never truncates
 *
 * Run:  node extensions/nw.test.mjs        (from the agent dir)
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve the real cli.js behind `pi`: either `pi` is (a symlink to) cli.js, or
// it's a wrapper script that does `exec node <path>/cli.js "$@"`.
const piReal = execSync("readlink -f $(command -v pi)").toString().trim();
let cliJs = piReal;
try {
	const wrapper = readFileSync(piReal, "utf8");
	const m = wrapper.match(/exec node (\S+cli\.js)/);
	if (m) cliJs = m[1];
} catch {
	// piReal wasn't readable as text (e.g. a binary) — assume it's cli.js itself.
}
const piRequire = createRequire(cliJs);
const jitiDir = dirname(piRequire.resolve("jiti/package.json"));
const { createJiti } = await import(`${jitiDir}/lib/jiti-static.mjs`);
const jiti = createJiti(import.meta.url);

const nw = await jiti.import(resolve(HERE, "nw.ts"));
const { pickNextResetWindow, scheduleAt, preview } = nw;

// Mock harness for the command handler (nw.ts has type-only pi imports).
function loadCommand({ currentState, forcedEntries = [] }) {
	const commands = {};
	let forcedFetch = false;
	const pi = {
		registerCommand: (n, o) => (commands[n] = o),
		on: () => {},
		sendUserMessage: () => {},
		events: {
			on: () => {},
			emit: (name, p) => {
				if (name !== "sub-core:request") return;
				if (p.type === "current") return p.reply({ state: currentState });
				forcedFetch = !!p.force;
				p.reply({ entries: p.force ? forcedEntries : [] });
			},
		},
	};
	nw.default(pi);
	return { handler: commands.nw.handler, forced: () => forcedFetch };
}
function mockCtx() {
	const widgets = {};
	const notes = [];
	return {
		ctx: {
			hasUI: true,
			model: { provider: "anthropic" },
			ui: { setWidget: (k, c) => (widgets[k] = c), notify: (m, t) => notes.push({ m, t }) },
		},
		widgets,
		notes,
	};
}

const MAX = 2 ** 31 - 1;
let failures = 0;
function test(name, fn) {
	try {
		const r = fn();
		if (r && typeof r.then === "function") return r.then(() => console.log(`ok - ${name}`)).catch((e) => {
			failures++;
			console.error(`FAIL - ${name}\n`, e);
		});
		console.log(`ok - ${name}`);
	} catch (e) {
		failures++;
		console.error(`FAIL - ${name}\n`, e);
	}
}

const now = Date.parse("2026-07-02T10:00:00Z");
const iso = (ms) => new Date(now + ms).toISOString();

await test("pickNextResetWindow: picks soonest future reset", () => {
	const win = pickNextResetWindow(
		[
			{ label: "Week", usedPercent: 5, resetAt: iso(6 * 24 * 3600e3) },
			{ label: "5h", usedPercent: 40, resetAt: iso(110 * 60e3) },
		],
		now,
	);
	assert.equal(win?.label, "5h");
});

await test("pickNextResetWindow: ignores past / missing / bad resetAt", () => {
	assert.equal(pickNextResetWindow([{ label: "5h", usedPercent: 1, resetAt: iso(-60e3) }], now), undefined);
	assert.equal(pickNextResetWindow([{ label: "x", usedPercent: 1 }], now), undefined);
	assert.equal(pickNextResetWindow([{ label: "x", usedPercent: 1, resetAt: "not-a-date" }], now), undefined);
	assert.equal(pickNextResetWindow([], now), undefined);
	assert.equal(pickNextResetWindow(undefined, now), undefined);
});

await test("scheduleAt: fires for a near delay", async () => {
	let fired = false;
	scheduleAt(Date.now() + 30, () => {
		fired = true;
	});
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(fired, true);
});

await test("scheduleAt: does not misfire on >24.8d delay (overflow guard)", async () => {
	let fired = false;
	const cancel = scheduleAt(Date.now() + 40 * 24 * 3600e3, () => {
		fired = true;
	});
	await new Promise((r) => setTimeout(r, 60));
	cancel();
	assert.equal(fired, false);
});

await test("scheduleAt: first chunk clamped to <= 2^31-1 ms", () => {
	const real = globalThis.setTimeout;
	const delays = [];
	// Capture the requested delay without actually scheduling.
	globalThis.setTimeout = (_fn, d) => {
		delays.push(d);
		return 0;
	};
	try {
		scheduleAt(5_000_000_000, () => {}, () => 0); // 5e9 ms out, now = 0
	} finally {
		globalThis.setTimeout = real;
	}
	assert.equal(delays[0], MAX);
});

await test("scheduleAt: cancel prevents firing", async () => {
	let fired = false;
	const cancel = scheduleAt(Date.now() + 40, () => {
		fired = true;
	});
	cancel();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(fired, false);
});

await test("preview: collapses whitespace, keeps full text", () => {
	assert.equal(preview("line one\n\n  line two   with   spaces"), "line one line two with spaces");
	const long = "refactor the entire authentication subsystem and add tests everywhere please";
	assert.equal(preview(long), long); // never truncates
});

// Regression: the current-state snapshot carries the 5h window even when the
// entries endpoint returns empty (its ~60s TTL dropped the stale entry during a
// long turn). /nw must still schedule off the live snapshot, not error out.
await test("handler: schedules from live current-state when entries are TTL-dropped", async () => {
	// Handler uses real Date.now(), so this must be a genuine future time.
	const win = { label: "5h", usedPercent: 32, resetAt: new Date(Date.now() + 75 * 60e3).toISOString() };
	const { handler, forced } = loadCommand({
		currentState: { provider: "anthropic", usage: { provider: "anthropic", windows: [win] } },
		forcedEntries: [],
	});
	const { ctx, notes } = mockCtx();
	await handler("overnight job", ctx);
	assert.equal(forced(), false); // never needed the forced fallback
	const last = notes.at(-1);
	assert.equal(last.t, "info");
	assert.match(last.m, /scheduled — anthropic 5h/);
	assert.match(last.m, /"overnight job"/);
});

await test("handler: cold-start falls back to one forced fetch", async () => {
	const win = { label: "5h", usedPercent: 1, resetAt: new Date(Date.now() + 2e6).toISOString() };
	const { handler, forced } = loadCommand({
		currentState: { provider: "anthropic", usage: { provider: "anthropic", windows: [] } },
		forcedEntries: [{ provider: "anthropic", usage: { provider: "anthropic", windows: [win] } }],
	});
	const { ctx, notes } = mockCtx();
	await handler("job", ctx);
	assert.equal(forced(), true);
	assert.match(notes.at(-1).m, /scheduled/);
});

await test("handler: errors cleanly when sub-core has no current provider", async () => {
	const { handler } = loadCommand({ currentState: undefined });
	const { ctx, notes } = mockCtx();
	await handler("job", ctx);
	assert.equal(notes.at(-1).t, "error");
	assert.match(notes.at(-1).m, /couldn't determine the current provider/);
});

if (failures) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall nw tests passed");
