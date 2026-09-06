// Run: node --test extensions/stop-after-turn.test.mjs
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Resolve dependencies from the installed pi, including the local shell wrapper.
const piPath = execSync("readlink -f $(command -v pi)").toString().trim();
const cli = readFileSync(piPath, "utf8").match(/exec node (\S+cli\.js)/)?.[1] ?? piPath;
const require = createRequire(cli);
const { createJiti } = await import(pathToFileURL(join(dirname(require.resolve("jiti/package.json")), "lib/jiti-static.mjs")));
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import(new URL("./stop-after-turn.ts", import.meta.url).pathname);

function harness({ idle = false, hasUI = true } = {}) {
	const events = new Map();
	let command;
	let aborts = 0;
	const statuses = new Map();
	const notes = [];
	const ctx = {
		hasUI,
		isIdle: () => idle,
		abort: () => { aborts++; },
		ui: {
			setStatus: (key, value) => statuses.set(key, value),
			notify: (text) => notes.push(text),
		},
	};
	if (!hasUI) ctx.ui = undefined;
	extension({
		on: (name, fn) => events.set(name, fn),
		registerCommand: (name, definition) => {
			assert.equal(name, "stop-after-turn");
			command = definition.handler;
		},
	});
	return {
		command: (args = "") => command(args, ctx),
		emit: (name) => events.get(name)?.({}, ctx),
		aborts: () => aborts,
		statuses, notes,
	};
}

test("arms immediately, aborts only at turn_end, blocks compaction until settled", async () => {
	const h = harness();
	await h.command();
	await h.command(); // repeated command doesn't toggle it off
	assert.equal(h.aborts(), 0);
	assert.ok(h.statuses.get("stop-after-turn"));
	h.emit("tool_result");
	assert.equal(h.aborts(), 0);
	assert.equal(h.emit("session_before_compact"), undefined);
	h.emit("turn_end");
	assert.equal(h.aborts(), 1);
	assert.equal(h.statuses.get("stop-after-turn"), undefined);
	assert.deepEqual(h.emit("session_before_compact"), { cancel: true });
	h.emit("turn_end");
	assert.equal(h.aborts(), 1);
	h.emit("turn_start"); // auto-retry may use a fresh signal
	assert.equal(h.aborts(), 2);
	h.emit("agent_settled");
	assert.equal(h.emit("session_before_compact"), undefined);
	h.emit("turn_start");
	h.emit("turn_end");
	assert.equal(h.aborts(), 2);
});

test("idle, cancel, invalid arguments, and session changes never arm a later turn", async () => {
	const idle = harness({ idle: true });
	await idle.command();
	idle.emit("turn_end");
	assert.equal(idle.aborts(), 0);
	for (const reset of ["cancel", "session_start", "session_shutdown", "agent_settled"]) {
		const h = harness();
		await h.command();
		if (reset === "cancel") await h.command(" cancel ");
		else h.emit(reset);
		h.emit("turn_end");
		assert.equal(h.aborts(), 0, reset);
		assert.equal(h.statuses.get("stop-after-turn"), undefined);
	}
	const invalid = harness();
	await invalid.command("oops");
	invalid.emit("turn_end");
	assert.equal(invalid.aborts(), 0);
	assert.match(invalid.notes[0], /Usage:/);
});

test("works without a UI", async () => {
	const h = harness({ hasUI: false });
	await h.command();
	h.emit("turn_end");
	h.emit("agent_settled");
	assert.equal(h.aborts(), 1);
});

// Real SDK/agent loop: a command dispatched while a tool is blocked must not
// abort any sibling tools, and the next provider invocation must be cancelled.
const sdk = await import(pathToFileURL(join(dirname(cli), "index.js")));
const piJiti = createJiti(cli);
const ai = await import(piJiti.esmResolve("@earendil-works/pi-ai"));
const { getModel } = await import(piJiti.esmResolve("@earendil-works/pi-ai/compat"));
const { Type } = await import(piJiti.esmResolve("typebox"));

for (const cancel of [false, true]) {
	test(`real session: mid-tool stop${cancel ? " then cancel" : ""}`, { timeout: 10000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-stop-after-turn-test-"));
		let session;
		try {
			const settingsManager = sdk.SettingsManager.inMemory({
				compaction: { enabled: false }, retry: { enabled: false },
			});
			const credentials = new ai.InMemoryCredentialStore();
			const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: join(dir, "models.json") });
			await modelRuntime.setRuntimeApiKey("anthropic", "test-key");
			const resourceLoader = new sdk.DefaultResourceLoader({
				cwd: dir, agentDir: dir, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				agentsFilesOverride: () => ({ agentsFiles: [] }),
				extensionFactories: [extension],
			});
			await resourceLoader.reload();
			const started = Promise.withResolvers();
			const release = Promise.withResolvers();
			const completed = [];
			const tool = {
				name: "wait", label: "wait", description: "test", parameters: Type.Object({}),
				async execute(id, _args, signal) {
					started.resolve();
					await release.promise;
					assert.equal(signal.aborted, false, "running tools must not be interrupted");
					completed.push(id);
					return { content: [{ type: "text", text: id }], details: {} };
				},
			};
			({ session } = await sdk.createAgentSession({
				cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader,
				model: getModel("anthropic", "claude-sonnet-4-5"),
				sessionManager: sdk.SessionManager.inMemory(dir), tools: ["wait"], customTools: [tool],
			}));
			let restoredQueue;
			await session.bindExtensions({
				mode: "print",
				// Same queue/abort semantics as InteractiveMode's Esc handler.
				abortHandler: () => {
					const queue = session.clearQueue();
					if (queue.steering.length || queue.followUp.length) restoredQueue = queue;
					void session.abort();
				},
			});
			let inferences = 0;
			let abortedContinuations = 0;
			session.agent.streamFunction = (_model, _context, options) => {
				if (options.signal.aborted) {
					abortedContinuations++;
					throw new Error("cancelled before inference");
				}
				inferences++;
				const message = {
					role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
					content: inferences === 1
						? ["one", "two"].map((id) => ({ type: "toolCall", id, name: "wait", arguments: {} }))
						: [{ type: "text", text: "done" }],
					stopReason: inferences === 1 ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = new ai.AssistantMessageEventStream();
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
				return stream;
			};
			const run = session.prompt("start");
			await started.promise;
			if (!cancel) {
				await session.steer("queued steering");
				await session.followUp("queued follow-up");
			}
			await session.prompt("/stop-after-turn");
			assert.equal(session.agent.signal.aborted, false);
			if (cancel) await session.prompt("/stop-after-turn cancel");
			release.resolve();
			await run;
			assert.deepEqual(completed.sort(), ["one", "two"]);
			assert.equal(session.messages.filter((m) => m.role === "toolResult").length, 2);
			assert.equal(inferences, cancel ? 2 : 1);
			assert.equal(abortedContinuations, cancel ? 0 : 1);
			assert.equal(session.isIdle, true);
			if (!cancel) assert.deepEqual(restoredQueue, { steering: ["queued steering"], followUp: ["queued follow-up"] });
			assert.equal(session.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("/stop-after-turn")), false);
			await session.prompt("resume");
			assert.equal(inferences, cancel ? 3 : 2, "stop must be one-shot");
		} finally {
			session?.dispose();
			// Only the unique temporary fixture directory created above.
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
