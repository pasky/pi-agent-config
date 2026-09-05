---
name: email
description: Search and read pasky's local email (notmuch over ~/Mail maildir), including extracting attachments (PDFs, docx, images). Use when asked to check/find something in email.
compatibility: Requires local notmuch index
---

# Email (notmuch)

pasky's mail lives in `~/Mail`, indexed by **notmuch**.

## FIRST: refresh the index

The index is NOT updated automatically on delivery. If you are looking for
anything from the last day or so, run this first, always:

```bash
notmuch new
```

(2026-09-03: a booking confirmation that had arrived 20 minutes earlier was
invisible to every search until `notmuch new` was run.)

## Search

```bash
notmuch search 'from:kacirek subject:XC40 date:2026-08-21'   # threads
notmuch search --output=messages 'from:kacirek date:2026-08-21'  # message ids
```

Useful terms: `from:` `to:` `subject:` `date:YYYY-MM-DD` (or ranges `date:aug21..`,
`date:today`, `date:yesterday..`), `attachment:name`, `tag:unread`, plain words
for full-text.

If a search comes up empty, the fix is `notmuch new`, not grepping
`~/Maildir` — bodies there are base64/quoted-printable, so grep won't find
the text anyway.

## Read a message / thread

```bash
notmuch show --format=raw id:MESSAGE_ID          # full RFC822 of one message
notmuch show --format=json thread:THREADID       # structured whole thread
```

For quick body text of a thread, `notmuch show thread:...` (plain format) is fine
(commercial HTML mail like booking.com carries a text/plain alternative, which
is what gets printed).

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
