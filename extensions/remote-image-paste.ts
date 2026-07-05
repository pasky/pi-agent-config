/**
 * remote-image-paste: make Ctrl+V image paste work over ssh/et from a Mac client.
 *
 * Transport: the Mac serves its clipboard as PNG on 127.0.0.1:7779 (launchd
 * inetd-style + pngpaste), reverse-tunneled to this box via:
 *   et -k1 -r 7779:7779 host        (or: ssh -R 7779:localhost:7779 host)
 * Optionally as a unix socket (preferred if present, safer on multi-user boxes):
 *   ssh -R ~/.pi-clip.sock:localhost:7779 host
 *
 * See remote-image-paste.mac-setup.md next to this file for the Mac side.
 *
 * Registers only on headless Linux (no DISPLAY/WAYLAND_DISPLAY), where pi's
 * built-in image paste is a guaranteed no-op anyway — so local/desktop pi
 * sessions keep the stock handler.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UNIX_SOCK = process.env.PI_REMOTE_CLIP_SOCK ?? path.join(os.homedir(), ".pi-clip.sock");
const TCP_PORT = Number(process.env.PI_REMOTE_CLIP_PORT ?? 7779);
const CONNECT_TIMEOUT_MS = 300; // localhost: either the tunnel is there or it isn't
const INACTIVITY_TIMEOUT_MS = 2000; // while streaming image bytes over the WAN

/** null = tunnel absent/unreachable; empty buffer = connected but nothing served */
function fetchClipboard(): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let connected = false;
		const sock = fs.existsSync(UNIX_SOCK)
			? net.connect(UNIX_SOCK)
			: net.connect(TCP_PORT, "127.0.0.1");
		const finish = (value: Buffer | null) => {
			sock.destroy();
			resolve(value);
		};
		sock.setTimeout(CONNECT_TIMEOUT_MS);
		sock.on("connect", () => {
			connected = true;
			sock.setTimeout(INACTIVITY_TIMEOUT_MS);
		});
		sock.on("timeout", () => finish(connected ? Buffer.concat(chunks) : null));
		sock.on("error", () => finish(null));
		sock.on("data", (chunk) => chunks.push(chunk));
		sock.on("close", () => finish(connected ? Buffer.concat(chunks) : null));
	});
}

function sniffImageExt(data: Buffer): string | null {
	if (data.length < 12) return null;
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "png";
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
	if (data.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
	if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP")
		return "webp";
	return null;
}

export default function (pi: ExtensionAPI) {
	if (process.platform !== "linux" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
		return; // built-in image paste can work here; don't shadow it
	}

	pi.registerShortcut("ctrl+v", {
		description: "Paste image from client-side (Mac) clipboard via reverse tunnel",
		handler: async (ctx) => {
			const data = await fetchClipboard();
			if (data === null) {
				// No tunnel (e.g. connected via mosh): silent, like the stock
				// handler on a headless box.
				return;
			}
			const ext = data.length > 0 ? sniffImageExt(data) : null;
			if (!ext) {
				ctx.ui.notify("No image on client clipboard (tunnel is up)", "warning");
				return;
			}
			const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.${ext}`);
			fs.writeFileSync(file, data);
			ctx.ui.pasteToEditor(file);
		},
	});
}
