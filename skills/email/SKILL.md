---
name: email
description: Search and read pasky's local email (notmuch over ~/Mail maildir), including extracting attachments (PDFs, docx, images). Use when asked to check/find something in email.
compatibility: Requires local notmuch index
---

# Email (notmuch)

pasky's mail lives in `~/Mail`, indexed by **notmuch**.

## Search

```bash
notmuch search 'from:kacirek subject:XC40 date:2026-08-21'   # threads
notmuch search --output=messages 'from:kacirek date:2026-08-21'  # message ids
```

Useful terms: `from:` `to:` `subject:` `date:YYYY-MM-DD` (or ranges `date:aug21..`),
`attachment:name`, `tag:unread`, plain words for full-text.

## Read a message / thread

```bash
notmuch show --format=raw id:MESSAGE_ID          # full RFC822 of one message
notmuch show --format=json thread:THREADID       # structured whole thread
```

For quick body text of a thread, `notmuch show thread:...` (plain format) is fine.

## Extract attachments

```bash
notmuch show --format=raw id:MESSAGE_ID > /tmp/msg.eml
uv run python - <<'EOF'
import email, email.policy
m = email.message_from_file(open('/tmp/msg.eml'), policy=email.policy.default)
for part in m.walk():
    if fn := part.get_filename():
        out = '/tmp/att-' + fn.replace('/','_').replace(' ','_')
        open(out,'wb').write(part.get_payload(decode=True))
        print('saved', out)
EOF
```

Then read PDFs with `uv run --with pypdf`, docx with `uv run --with python-docx`.
Beware non-ASCII filenames (č/š/ž): glob rather than typing them literally.
