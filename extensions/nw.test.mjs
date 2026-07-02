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

const { pickNextResetWindow, scheduleAt, preview } = await jiti.import(resolve(HERE, "nw.ts"));

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

if (failures) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall nw tests passed");
