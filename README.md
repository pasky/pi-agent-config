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

## What's here

- `settings.json` — default provider/model, enabled models, packages
- `modes.json` — custom modes (rush/smart/deep/brm)
- `system-prompt.txt` — custom system prompt
- `packages/` — pi extensions as git submodules:
  - `pi-amplike` — skills (web search, visit webpage, session query), extensions (modes, handoff, etc.)
  - `pi-sub` — sub-core and sub-bar extensions
  - `pi-side-agents` — background side agents in tmux worktrees for parallel async workflows
  - `pi-blindtest` — blind model testing extension
  - `claude-agent-sdk-pi` — custom provider routing LLM calls through the Claude Agent SDK
  - `chrome-cdp-skill` — skill for interacting with a live Chrome browser session via CDP

## What's excluded

- `auth.json` — OAuth tokens, recreated by `pi` on each machine
- `sessions/` — conversation history
- `cache/`, `bin/`, `*.log` — ephemeral/platform-specific
- `skills-all/` — optional extra skills, install separately if needed
