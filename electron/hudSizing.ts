export interface HudSizingRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HudSizingWorkArea extends HudSizingRect {}

/**
 * Transparent padding added around the measured HUD content when sizing the
 * window — room for the bar's shadow/glow so it isn't cut off, while keeping
 * the dead click ring thin (Linux has no mouse passthrough, so every window
 * pixel blocks the desktop).
 */
export const HUD_CONTENT_RING_PX = 10;

export type HudSizingEnv = Record<string, string | string[] | undefined>;

/**
 * True when Electron's windows are driven by an X server — native X11 or
 * XWayland — where programmatic setBounds positioning is exact and the HUD
 * window can be resized to exactly its content. False for native-Wayland
 * Electron, which keeps the legacy fixed-size window (compositors there
 * refuse client-side positioning).
 *
 * A Wayland *session* alone is not enough to answer "no": Electron only runs
 * native Wayland when asked (ELECTRON_OZONE_PLATFORM_HINT=wayland/auto, or an
 * explicit --ozone-platform=wayland). Everything else — plain X11 sessions
 * and XWayland-under-hint-auto-with-X11-fallback — lands on the X11 backend.
 */
export function isXClientWindowing(
	env: HudSizingEnv,
	platform: NodeJS.Platform,
	argv: string[] = [],
): boolean {
	if (platform !== "linux") {
		return false;
	}
	if (argv.some((arg) => arg.includes("ozone-platform=wayland"))) {
		return false;
	}
	const sessionType = typeof env.XDG_SESSION_TYPE === "string" ? env.XDG_SESSION_TYPE : "";
	if (sessionType !== "wayland") {
		return typeof env.DISPLAY === "string" && env.DISPLAY.trim().length > 0;
	}
	const hint = typeof env.ELECTRON_OZONE_PLATFORM_HINT === "string" ? env.ELECTRON_OZONE_PLATFORM_HINT : "";
	if (hint === "wayland" || hint === "auto") {
		return false;
	}
	// Wayland session but Electron steered to X11 (hint=x11, unset, or an
	// explicit --ozone-platform=x11) → it is an X client (XWayland).
	return true;
}

export type HudWindowMode = "legacy" | "shape" | "grow";

/**
 * Which sizing strategy the HUD window uses:
 * - "shape": X clients — constant tall window, X11 shape extension carves
 *   paint+input to the content rects (see electron/hudOverlayShape.ts).
 * - "grow": native-Wayland Electron (anything Linux that is not an X client)
 *   — the compositor owns placement but pins the top-left corner on resizes,
 *   so the bar is anchored to the window's TOP and opening a popover grows
 *   the window downward. Idle rectangle hugs the bar; menus appear below it.
 * - "legacy": everything else — today's fixed 860x160 window, unchanged.
 *
 * RECORDLY_FORCE_HUD_WINDOW_MODE=shape|grow|legacy overrides for testing a
 * mode on a machine that wouldn't get it natively (dev-only escape hatch).
 */
export function resolveHudWindowMode(
	env: HudSizingEnv,
	platform: NodeJS.Platform,
	argv: string[] = [],
): HudWindowMode {
	const forced = env.RECORDLY_FORCE_HUD_WINDOW_MODE;
	if (forced === "shape" || forced === "grow" || forced === "legacy") {
		return forced;
	}
	if (platform !== "linux") {
		return "legacy";
	}
	return isXClientWindowing(env, platform, argv) ? "shape" : "grow";
}
