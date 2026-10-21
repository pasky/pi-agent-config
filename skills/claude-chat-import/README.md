# claude-import

A pi **skill** that imports a claude.ai chat conversation into a local
directory: readable transcript + the artifacts (code/documents Claude
created in the chat) as real files, ready to continue the work in a local
pi session.

The skill lives in [`skills/claude-chat-import/`](skills/claude-chat-import/)
— one `SKILL.md` + one Python script.

## Usage

Tell pi: *"import this claude.ai chat https://claude.ai/chat/2690b692-..."*

Or run directly:

```bash
skills/claude-chat-import/import.py https://claude.ai/chat/<uuid> [dest-dir]
skills/claude-chat-import/import.py --list     # list recent conversations
```

Result: `dest/` contains the chat's artifact files (final versions, with
incremental `update` commands applied), and `session/` with
`transcript.md`, raw `conversation.json`, and extracted `attachments/`.

Install by symlinking into pi's skill dir:

```bash
ln -s "$PWD/skills/claude-chat-import" ~/.pi/agent/skills/claude-chat-import
```

## How it works (research notes)

- Chat URL: `https://claude.ai/chat/<conversation-uuid>`.
- Backend API (unofficial, widely reverse-engineered and stable for years):
  - `GET https://claude.ai/api/organizations` — the account's orgs
  - `GET .../organizations/{org}/chat_conversations` — list chats
  - `GET .../organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
    — full conversation: `chat_messages[]` with `sender` (human/assistant)
    and `content[]` blocks (`text`, `thinking`, `tool_use`, `tool_result`),
    plus `attachments[]` (with `extracted_content`) and `files`/`files_v2`.
- **Artifacts** are `tool_use` blocks with `name == "artifacts"`; input has
  `id`, `command` (`create`/`rewrite`/`update`), `title`, `type`,
  `language`, `content` (or `old_str`/`new_str` for updates). The script
  replays these per artifact id to reconstruct final file contents.
- **Code-execution sandbox files** (created via `bash_tool`/`create_file`,
  surfaced with `present_files` → `local_resource` results) live in a
  per-conversation VFS codenamed **wiggle** (found by grepping claude.ai's
  frontend bundles):
  `GET /api/organizations/{org}/conversations/{conv}/wiggle/download-file?path=/mnt/user-data/outputs/...`
  — serves current sandbox state; expires for old chats. There's also a
  `download-files` (plural, `paths=` repeated) variant, and
  `snapshots/{uuid}/wiggle/...` for shared chats.
- **User uploads** appear in `files`/`files_v2` with `preview_url`
  (`/api/{org}/files/{uuid}/preview` — note: no `organizations` prefix,
  may re-encode images).
- **Auth**: the browser's `sessionKey` cookie (`sk-ant-sid01-...`) — the
  Claude Code CLI OAuth token does *not* work against `claude.ai/api`
  (returns 403). No official API exists for claude.ai chats.
- claude.ai sits behind Cloudflare, which blocks vanilla python UAs, hence
  `curl_cffi` with `impersonate="chrome"`.

### Limitations

- Uploads are saved from `preview_url`, which may be a re-encoded preview
  (e.g. a `.jpg` photo comes back as WebP), not byte-exact originals.
- Sandbox (wiggle) files are only downloadable while the conversation's
  VFS is still alive; old chats may 404 (warned, non-fatal).
- `update` artifact commands are replayed with plain first-occurrence
  string replacement — matches claude.ai semantics closely but not
  guaranteed byte-perfect; raw commands remain in `conversation.json`.

### Prior iteration

The first iteration of this repo imported **Claude Code on the web**
sessions (`claude.ai/code/session_...`) instead — transcript via the
teleport API + GitHub branch clone. That turned out to be a
misunderstanding of the original request; see git history (`d8cf249`) if
you ever need it, incl. research notes on the `/v1/code/sessions`
endpoints and `~/.claude` OAuth.
