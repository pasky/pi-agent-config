---
name: claude-chat-import
description: Import a claude.ai chat conversation (URL like https://claude.ai/chat/<uuid>) into a local directory — downloads the full transcript, extracts artifacts (code/documents Claude created in the chat) as real files, ready to continue the work locally. Use when the user asks to import, download, or continue a claude.ai chat.
compatibility: Requires uv, network access, and the user's claude.ai sessionKey browser cookie
---

# Claude Chat Import

Downloads a claude.ai conversation via the claude.ai backend API
(browser-impersonated via curl_cffi; Cloudflare-fronted).

## Auth setup (once)

Needs the user's claude.ai **sessionKey cookie** — there is no API-key path
for claude.ai chats. If `~/.config/claude-import/session_key` doesn't exist,
ask the user to provide it:

> In a browser logged into claude.ai: DevTools (F12) → Application →
> Cookies → https://claude.ai → copy the `sessionKey` value
> (starts with `sk-ant-sid01-...`), then:
> `mkdir -p ~/.config/claude-import && chmod 700 ~/.config/claude-import; cat > ~/.config/claude-import/session_key` (paste, Enter, Ctrl-D)

`$CLAUDE_SESSION_KEY` env var also works. The cookie is long-lived but does
expire eventually; on HTTP 401/403 ask for a fresh one.

## Usage

```bash
{baseDir}/import.py <chat-url-or-uuid> [dest-dir]
{baseDir}/import.py --list          # list the user's recent conversations
```

`dest-dir` defaults to a slug of the chat title in the cwd. The result:

- `dest/*` — files Claude created in the chat: classic artifacts
  (reconstructed at final version, updates applied) and code-execution
  sandbox files it presented (downloaded via the "wiggle" VFS API)
- `dest/session/transcript.md` — readable transcript
- `dest/session/conversation.json` — raw API response (full fidelity)
- `dest/session/attachments/` — user uploads (images/previews) and
  text extracted from them

## After importing

1. Skim `dest/session/transcript.md` and the artifact files, summarize
   for the user what the chat was about and where it left off.
2. Tell the user it's ready: `cd dest && pi` — the transcript is there for
   the new session to read for full context.

## Troubleshooting

- **401/403**: expired/invalid sessionKey → ask user for a fresh cookie.
- **Conversation not found**: script tries all the user's organizations;
  if it still fails, the chat may belong to a different claude.ai account.
- **Sandbox file download fails**: the code-execution VFS
  (`.../conversations/{uuid}/wiggle/download-file?path=...`) serves the
  *current* sandbox state; for old conversations it may have expired —
  the script warns and continues.
- **Uploads** are fetched via their `preview_url` (may be a re-encoded
  preview rather than the original byte-exact upload).
