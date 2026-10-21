#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["curl_cffi"]
# ///
"""Import a claude.ai chat conversation into a local directory.

Usage:
  import.py <chat-url-or-uuid> [dest-dir]    # import conversation
  import.py --list                           # list recent conversations

Downloads the full transcript, extracts artifacts (code/documents Claude
created in the chat) as real files, and saves user-uploaded attachment text.

Auth: claude.ai sessionKey browser cookie, from $CLAUDE_SESSION_KEY or
~/.config/claude-import/session_key (DevTools: Application > Cookies >
https://claude.ai > sessionKey, value starts with sk-ant-sid01-...).
"""

import json
import os
import re
import sys

from curl_cffi import requests

BASE = "https://claude.ai/api"

ARTIFACT_EXT = {
    "application/vnd.ant.react": ".jsx",
    "application/vnd.ant.mermaid": ".mmd",
    "text/html": ".html",
    "text/markdown": ".md",
    "image/svg+xml": ".svg",
}
LANG_EXT = {"python": ".py", "javascript": ".js", "typescript": ".ts", "bash": ".sh",
            "c": ".c", "cpp": ".cpp", "rust": ".rs", "go": ".go", "java": ".java",
            "html": ".html", "css": ".css", "json": ".json", "sql": ".sql"}


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def slug(s: str, fallback: str = "untitled") -> str:
    return re.sub(r"[^\w-]+", "-", s.lower()).strip("-")[:48] or fallback


def get_session_key() -> str:
    if key := os.environ.get("CLAUDE_SESSION_KEY"):
        return key.strip()
    path = os.path.expanduser("~/.config/claude-import/session_key")
    try:
        return open(path).read().strip()
    except OSError:
        die(f"no claude.ai session cookie. Put it in $CLAUDE_SESSION_KEY or {path}\n"
            "  (browser DevTools: Application > Cookies > https://claude.ai > sessionKey)")


def api_get(path: str, key: str, params: dict | None = None, raw: bool = False):
    r = requests.get(BASE + path, params=params or {}, impersonate="chrome",
                     cookies={"sessionKey": key},
                     headers={"Accept": "application/json"}, timeout=120)
    if r.status_code in (401, 403):
        die(f"HTTP {r.status_code} from claude.ai — sessionKey cookie invalid/expired? "
            "Grab a fresh one from the browser.")
    r.raise_for_status()
    return r.content if raw else r.json()


def get_orgs(key: str) -> list[dict]:
    orgs = api_get("/organizations", key)
    # chat-capable orgs first
    return sorted(orgs, key=lambda o: "chat" not in (o.get("capabilities") or ["chat"]))


def fetch_conversation(uuid: str, key: str) -> tuple[str, dict]:
    last_err = None
    for org in get_orgs(key):
        try:
            return org["uuid"], api_get(
                f"/organizations/{org['uuid']}/chat_conversations/{uuid}", key,
                {"tree": "True", "rendering_mode": "messages",
                 "render_all_tools": "true"})
        except requests.exceptions.HTTPError as e:
            last_err = e
    die(f"conversation {uuid} not found in any of your organizations ({last_err})")


def sandbox_paths(conv: dict) -> list[str]:
    """Files Claude presented from its code-execution sandbox (VFS 'wiggle')."""
    paths: dict[str, None] = {}
    for msg in conv.get("chat_messages", []):
        for b in msg.get("content") or []:
            if b.get("type") == "tool_use" and b.get("name") == "present_files":
                for p in (b.get("input") or {}).get("filepaths") or []:
                    paths[p] = None
            elif b.get("type") == "tool_result":
                for e in b.get("content") or []:
                    if isinstance(e, dict) and e.get("type") == "local_resource" \
                            and e.get("file_path"):
                        paths[e["file_path"]] = None
    return [p.replace("computer://", "") for p in paths]


def pick_name(want: str, taken: set[str]) -> str:
    name, i = want, 2
    while name in taken:
        stem, ext = os.path.splitext(want)
        name, i = f"{stem}-{i}{ext}", i + 1
    taken.add(name)
    return name


def download_sandbox_files(conv: dict, org: str, key: str, dest: str,
                           taken: set[str]) -> list[str]:
    written = []
    for p in sandbox_paths(conv):
        name = pick_name(os.path.basename(p) or "file", taken)
        try:
            data = api_get(f"/organizations/{org}/conversations/{conv['uuid']}"
                           "/wiggle/download-file", key, {"path": p}, raw=True)
        except requests.exceptions.HTTPError as e:
            print(f"  sandbox file {p} failed ({e}) — sandbox expired?", file=sys.stderr)
            continue
        open(os.path.join(dest, name), "wb").write(data)
        written.append(name)
    return written


def download_uploads(conv: dict, key: str, attach_dir: str) -> int:
    n, seen = 0, set()
    for msg in conv.get("chat_messages", []):
        for f in (msg.get("files") or []) + (msg.get("files_v2") or []):
            url = f.get("preview_url") or f.get("thumbnail_url")
            if not url or f.get("file_uuid") in seen:
                continue
            seen.add(f.get("file_uuid"))
            try:
                data = api_get(url.removeprefix("/api"), key, raw=True)
            except requests.exceptions.HTTPError as e:
                print(f"  upload {f.get('file_name')} failed ({e})", file=sys.stderr)
                continue
            os.makedirs(attach_dir, exist_ok=True)
            name = os.path.basename(f.get("file_name") or f["file_uuid"])
            open(os.path.join(attach_dir, name), "wb").write(data)
            n += 1
    return n


class Artifacts:
    """Reconstruct artifact files from `artifacts` tool_use blocks."""

    def __init__(self):
        self.arts: dict[str, dict] = {}

    def apply(self, inp: dict) -> str:
        aid = inp.get("id") or "artifact"
        art = self.arts.setdefault(aid, {"content": ""})
        for k in ("title", "type", "language"):
            if inp.get(k):
                art[k] = inp[k]
        cmd = inp.get("command")
        if cmd in ("create", "rewrite"):
            art["content"] = inp.get("content") or ""
        elif cmd == "update":
            art["content"] = art["content"].replace(
                inp.get("old_str") or "", inp.get("new_str") or "", 1)
        return aid

    def filename(self, aid: str) -> str:
        art = self.arts[aid]
        ext = ARTIFACT_EXT.get(art.get("type", "")) or \
            LANG_EXT.get((art.get("language") or "").lower()) or ".txt"
        base = slug(art.get("title", ""), aid)
        return base if base.endswith(ext) else base + ext

    def write_all(self, dest: str, taken: set[str]) -> list[str]:
        written = []
        for aid in self.arts:
            name = pick_name(self.filename(aid), taken)
            with open(os.path.join(dest, name), "w") as fh:
                fh.write(self.arts[aid]["content"])
            written.append(name)
        return written


def render(conv: dict, arts: Artifacts, attach_dir: str) -> str:
    out = [f"# {conv.get('name') or 'Untitled chat'}", "",
           f"Imported from https://claude.ai/chat/{conv.get('uuid')} "
           f"({conv.get('updated_at', '')[:10]})", ""]
    n_attach = 0
    for msg in conv.get("chat_messages", []):
        role = "👤 User" if msg.get("sender") == "human" else "🤖 Claude"
        parts = []
        for att in (msg.get("attachments") or []):
            fname = os.path.basename(att.get("file_name") or f"attachment-{n_attach}")
            parts.append(f"- 📎 attached: `{fname}`")
            if att.get("extracted_content"):
                os.makedirs(attach_dir, exist_ok=True)
                open(os.path.join(attach_dir, fname), "w").write(att["extracted_content"])
                n_attach += 1
        for f in (msg.get("files") or []) + (msg.get("files_v2") or []):
            parts.append(f"- 📎 uploaded file: `{f.get('file_name')}` "
                         "(in session/attachments/)")
        for blk in (msg.get("content") or [{"type": "text", "text": msg.get("text", "")}]):
            t = blk.get("type")
            if t == "text" and blk.get("text", "").strip():
                parts.append(blk["text"])
            elif t == "tool_use" and blk.get("name") == "artifacts":
                inp = blk.get("input") or {}
                aid = arts.apply(inp)
                parts.append(f"- 📄 artifact {inp.get('command', '?')}: "
                             f"`{arts.filename(aid)}`")
            elif t == "tool_use" and blk.get("name") == "present_files":
                fps = (blk.get("input") or {}).get("filepaths") or []
                parts.append("- 📄 presented files: " +
                             ", ".join(f"`{os.path.basename(p)}`" for p in fps))
            elif t == "tool_use":
                arg = json.dumps(blk.get("input", {}), ensure_ascii=False)
                parts.append(f"- 🔧 `{blk.get('name')}` {arg[:300]}")
            elif t == "tool_result" and blk.get("is_error"):
                parts.append(f"- ⚠️ tool error: {json.dumps(blk.get('content'))[:300]}")
        if parts:
            out += [f"## {role}", ""] + [p for part in parts for p in (part, "")]
    return "\n".join(out)


def list_conversations(key: str):
    for org in get_orgs(key):
        convs = api_get(f"/organizations/{org['uuid']}/chat_conversations", key,
                        {"limit": 30})
        for c in convs if isinstance(convs, list) else convs.get("data", []):
            print(f"{c.get('uuid')}  {c.get('updated_at', '')[:16]}  "
                  f"{(c.get('name') or '')[:60]}")
        break  # first (chat-capable) org is enough for the common case


def main():
    args = [a for a in sys.argv[1:] if a != "--list"]
    if (not args and "--list" not in sys.argv) or (args and args[0] in ("-h", "--help")):
        die(__doc__.strip())
    key = get_session_key()
    if "--list" in sys.argv:
        return list_conversations(key)

    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                  args[0], re.I)
    if not m:
        die(f"cannot find a conversation uuid in {args[0]!r}")
    uuid = m.group(1)

    print(f"fetching conversation {uuid} ...")
    org, conv = fetch_conversation(uuid, key)
    title = conv.get("name") or ""
    print(f"  title:    {title or '(untitled)'}\n"
          f"  messages: {len(conv.get('chat_messages', []))}")

    dest = args[1] if len(args) > 1 else slug(title, uuid)
    if os.path.exists(dest) and os.listdir(dest):
        die(f"destination {dest!r} exists and is not empty")
    sdir = os.path.join(dest, "session")
    os.makedirs(sdir, exist_ok=True)

    arts = Artifacts()
    attach_dir = os.path.join(sdir, "attachments")
    md = render(conv, arts, attach_dir)
    json.dump(conv, open(os.path.join(sdir, "conversation.json"), "w"), indent=2)
    open(os.path.join(sdir, "transcript.md"), "w").write(md)
    taken = {"session"}
    files = arts.write_all(dest, taken)
    files += download_sandbox_files(conv, org, key, dest, taken)
    n_up = download_uploads(conv, key, attach_dir)

    print(f"\nimported into {dest}/  ({len(files)} artifact files, "
          f"{n_up} uploads saved)")
    for f in files:
        print(f"  {dest}/{f}")
    print(f"  transcript: {dest}/session/transcript.md")
    print(f"ready: cd {dest} && pi")


if __name__ == "__main__":
    main()
