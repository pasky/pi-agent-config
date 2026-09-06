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

## `/stop-after-turn`

Finish the current model response and all its tool calls, then stop before further automatic inference. Unlike Esc, it doesn't interrupt the tools. In the TUI, queued messages return to the editor, even when the response ends without tool calls.

- Run `/reload` after installing, then `/stop-after-turn` while a response or tool is running.
- Use `/stop-after-turn cancel` to disarm **before the turn ends**; an already-issued abort cannot be undone.
- One-shot; does nothing without an active agent turn. It cannot be armed between runs during retry backoff or overflow compaction, even if a retry will follow.
- Suppresses automatic compaction while stopping, but leaves explicit `/compact` requests to pi's normal handling.

In headless/RPC use, pi's default abort does not restore queued messages: steering may enter the transcript without an answer. Avoid pending messages there, or supply an SDK abort handler that preserves the queues.

Test: `node --test extensions/stop-after-turn.test.mjs` (uses the installed pi SDK with a mock model).

## What's excluded

- `auth.json` — OAuth tokens, recreated by `pi` on each machine
- `sessions/` — conversation history
- `cache/`, `bin/`, `*.log` — ephemeral/platform-specific
- `skills-all/` — optional extra skills, install separately if needed
