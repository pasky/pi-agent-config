# Mac-side setup for remote-image-paste.ts

One-time, on the Mac:

```bash
brew install pngpaste
```

Create `~/Library/LaunchAgents/org.pasky.clipserve.plist` — launchd itself
listens on 127.0.0.1:7779 and spawns `pngpaste -` per connection (inetd-style,
no daemon running when idle):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>org.pasky.clipserve</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/pngpaste</string>
		<string>-</string>
	</array>
	<key>inetdCompatibility</key>
	<dict><key>Wait</key><false/></dict>
	<!-- keep pngpaste's stderr (e.g. "no image" error text) off the socket -->
	<key>StandardErrorPath</key><string>/tmp/pngpaste-clipserve.err</string>
	<key>Sockets</key>
	<dict>
		<key>Listener</key>
		<dict>
			<key>SockNodeName</key><string>127.0.0.1</string>
			<key>SockServiceName</key><string>7779</string>
		</dict>
	</dict>
</dict>
</plist>
```

(Intel Mac: pngpaste lives at `/usr/local/bin/pngpaste` instead.)

Activate and test locally (take a screenshot to clipboard first, cmd-ctrl-shift-4):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.pasky.clipserve.plist
nc 127.0.0.1 7779 | file -        # expect: PNG image data ...
```

## Connecting

Add the reverse tunnel to your usual connection:

```bash
et -k1 -r 7779:7779 user@host
# or ssh; in ~/.ssh/config on the mac:
#   Host thatbox
#     RemoteForward 7779 localhost:7779
```

Then Ctrl+V in remote pi pastes the Mac clipboard image. Test end-to-end on
the remote box with: `nc -w2 localhost 7779 | file -`

Notes:

- Multiple simultaneous connections: only the first gets the remote port
  (ssh prints a warning for the rest). Harmless.
- Multi-user remote box hardening: tunnel to a unix socket instead —
  `ssh -R /home/USER/.pi-clip.sock:localhost:7779` (the pi extension prefers
  `~/.pi-clip.sock` when it exists; sshd needs `StreamLocalBindUnlink yes`
  to handle stale sockets). With et, `-r` also accepts socket paths.
- The extension reads `PI_REMOTE_CLIP_PORT` / `PI_REMOTE_CLIP_SOCK` env vars
  to override defaults.
- Empty clipboard: `pngpaste` exits non-zero with an error on stderr. In inetd
  mode launchd would connect stderr to the socket too; the `StandardErrorPath`
  key in the plist redirects it to `/tmp/pngpaste-clipserve.err` so the
  extension gets a clean empty read. (Even without it, the image-magic
  sniffing rejects the error text.) pi shows "No image on client clipboard"
  either way.
- Non-PNG images on the clipboard (e.g. JPEG copied from a browser) are fine:
  pngpaste converts to PNG on the way out.
