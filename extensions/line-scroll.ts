/**
 * line-scroll — vi-style single-line transcript scrolling in fullscreen mode.
 *
 * pi's fullscreen (`--tui-mode fullscreen`) transcript only has page and
 * half-page scroll actions; the mouse wheel scrolls by single lines but there
 * is no keybindable equivalent. This extension adds the traditional vi/less
 * bindings:
 *
 *   ctrl+y  scroll transcript up one line
 *   ctrl+e  scroll transcript down one line
 *
 * How it works:
 *   1. The TUI instance is not exposed on the extension context directly, so
 *      we capture it via a zero-render setWidget factory (factories receive
 *      the live TUI object).
 *   2. ctx.ui.onTerminalInput handlers run before all TUI key routing and may
 *      consume input, so we claim ctrl+e/ctrl+y there and call
 *      TuiAltScreen.scrollBy(+-1) — the same method the mouse wheel path uses.
 *
 * Caveats:
 *   - Only active in fullscreen mode (in the default TUI mode the captured
 *     tui is not a TuiAltScreen, and all keys pass through untouched).
 *   - In fullscreen mode this shadows the default editor bindings for
 *     ctrl+e (move to end of line) and ctrl+y (yank). Edit SCROLL_UP_KEY /
 *     SCROLL_DOWN_KEY below if you'd rather keep those.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, TuiAltScreen } from "@earendil-works/pi-tui";

const SCROLL_UP_KEY = "ctrl+y";
const SCROLL_DOWN_KEY = "ctrl+e";

export default function (pi: ExtensionAPI) {
	let tui: TuiAltScreen | undefined;

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget("line-scroll-capture", (t) => {
			if (t instanceof TuiAltScreen) tui = t;
			return { render: () => [] };
		});

		ctx.ui.onTerminalInput((data) => {
			if (!tui) return undefined;
			if (matchesKey(data, SCROLL_UP_KEY)) {
				if (!isKeyRelease(data)) tui.scrollBy(-1);
				return { consume: true };
			}
			if (matchesKey(data, SCROLL_DOWN_KEY)) {
				if (!isKeyRelease(data)) tui.scrollBy(1);
				return { consume: true };
			}
			return undefined;
		});
	});
}
