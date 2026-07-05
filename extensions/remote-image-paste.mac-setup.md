# Client-side setup for remote-image-paste.ts

Per client box (Mac instructions; any OS works if it serves clipboard PNG
on 127.0.0.1:7779). Supports multiple boxen attached to the same tmux: each
box gets its own socket `~/.pi-clip/<box>.sock` on the remote, and the
extension picks the socket of the tmux client that pressed Ctrl+V.

## 1. Clipboard server (Mac)

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
		<!-- TCP listener: used by ssh RemoteForward -->
		<key>ListenerTCP</key>
		<dict>
			<key>SockNodeName</key><string>127.0.0.1</string>
			<key>SockServiceName</key><string>7779</string>
		</dict>
		<!-- Unix socket listener: used by et's env-var reverse tunnel -->
		<key>ListenerUnix</key>
		<dict>
			<key>SockPathName</key><string>/Users/pasky/.clipserve.sock</string>
		</dict>
	</dict>
</dict>
</plist>
```

(Intel Mac: pngpaste lives at `/usr/local/bin/pngpaste` instead.)

Activate and test locally (screenshot to clipboard first, cmd-ctrl-shift-4):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.pasky.clipserve.plist
nc 127.0.0.1 7779 | file -        # expect: PNG image data ...
```

## 2. Tunnel + box identity

Pick a short name for the box (e.g. `mbp`). In the box's `~/.ssh/config`:

```
Host thatbox
	RemoteForward /home/pasky/.pi-clip/mbp.sock localhost:7779
	SetEnv LC_PI_CLIP=mbp
```

(`LC_*` chosen because Debian sshd accepts it by default — no server config
needed. The remote `~/.bashrc` hook symlinks the login tty to the box's
socket so the extension can resolve tmux-client -> box.)

With et (released 6.2.x), remote unix socket paths in tunnels are NOT
supported (`-r /path.sock:7779` fails with a bogus "port range" error; the
socket-path syntax only exists in unreleased master). Use the env-var
named-pipe form instead — TESTED WORKING on 6.2.11:

```bash
et -k1 -r PI_CLIP_SOCK:/Users/pasky/.clipserve.sock thatbox
```

et creates a private per-connection socket on the remote
(`/tmp/et_forward_sock_XXXXXX/sock`, mode 0700), exports its path as
`$PI_CLIP_SOCK` in the session, and connects it to the client-side UNIX
socket named after the colon (the launchd ListenerUnix above; absolute
client-side path, no `~`). The remote `~/.bashrc` hook symlinks the login
tty to `$PI_CLIP_SOCK`, so et needs no LC_PI_CLIP/box name at all.

Note: if aliased unconditionally, the tunnel is requested on every et
connection; hosts where it can't be set up may complain. Scope the alias
per-host if you et elsewhere too.

(et's ssh bootstrap still applies SetEnv from ssh config.)

## 3. Remote server one-timers (mostly done already)

- `mkdir -p ~/.pi-clip/by-tty && chmod 700 ~/.pi-clip` — done.
- tty->box mapping hook in `~/.bashrc` — done.
- Recommended (needs root): let sshd replace stale socket files after unclean
  disconnects, otherwise the re-established forward fails until the stale
  `.sock` file is removed manually:

  ```bash
  echo 'StreamLocalBindUnlink yes' | sudo tee /etc/ssh/sshd_config.d/60-pi-clip.conf
  sudo sshd -t && sudo systemctl reload ssh
  ```

## How Ctrl+V picks a box

1. tmux client with the newest `client_activity` (= the one that typed) ->
   `~/.pi-clip/by-tty/<tty>.sock` symlink -> that box's socket.
2. Fallback: every `~/.pi-clip/*.sock`, newest first.
3. Legacy: `~/.pi-clip.sock`, then TCP 127.0.0.1:7779.

Dead/stale sockets are probed (300 ms) and skipped. If a live socket is
found but the box's clipboard has no image, pi shows a warning and does NOT
fall through to another box's clipboard.

Test end-to-end from the remote box: `nc -w2 -U ~/.pi-clip/mbp.sock | file -`

## Notes

- Empty clipboard: `pngpaste` exits non-zero with an error on stderr. In inetd
  mode launchd would connect stderr to the socket too; the `StandardErrorPath`
  key in the plist redirects it to `/tmp/pngpaste-clipserve.err` so the
  extension gets a clean empty read. (Even without it, the image-magic
  sniffing rejects the error text.) pi shows "No image on client clipboard"
  either way.
- Non-PNG images on the clipboard (e.g. JPEG copied from a browser) are fine:
  pngpaste converts to PNG on the way out.
- Env overrides read by the extension: `PI_REMOTE_CLIP_DIR`,
  `PI_REMOTE_CLIP_SOCK` (legacy single socket), `PI_REMOTE_CLIP_PORT`.
