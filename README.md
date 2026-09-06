# pi agent config

My [pi](https://github.com/mariozechner/pi) coding agent configuration, portable across machines.

## Fresh install

```bash
git clone --recurse-submodules git@github.com:pasky/pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent
./setup.sh
```

Then run `pi` and authenticate (creates `auth.json` locally).

## Updating

```bash
cd ~/.pi/agent
git pull
```

The post-merge hook runs `setup.sh` automatically (submodule update + npm install).

If the hook doesn't fire (first pull after clone), run `./setup.sh` manually.

## Local commands

- `/stop-after-turn` — finish the current model response and all its tool calls, then stop before further inference. Works while a tool is running; unlike Esc, it doesn't interrupt the tools. In the TUI, queued messages return to the editor. Use `/stop-after-turn cancel` to disarm. One-shot; does nothing when idle. Run `/reload` after installing.

In headless/RPC use, pi's default abort does not restore queued messages: steering may enter the transcript without an answer. Avoid pending messages there, or supply an SDK abort handler that preserves the queues.

Test: `node --test extensions/stop-after-turn.test.mjs` (uses the installed pi SDK with a mock model).

## What's excluded

- `auth.json` — OAuth tokens, recreated by `pi` on each machine
- `sessions/` — conversation history
- `cache/`, `bin/`, `*.log` — ephemeral/platform-specific
- `skills-all/` — optional extra skills, install separately if needed
