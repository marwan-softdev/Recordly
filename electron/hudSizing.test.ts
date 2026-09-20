import { describe, expect, it } from "vitest";
import { isXClientWindowing, resolveHudWindowMode } from "./hudSizing";

describe("isXClientWindowing", () => {
	it("is false off Linux", () => {
		expect(isXClientWindowing({ DISPLAY: ":0" }, "win32")).toBe(false);
		expect(isXClientWindowing({ DISPLAY: ":0" }, "darwin")).toBe(false);
	});

	it("is true for a plain X11 session", () => {
		expect(
			isXClientWindowing({ XDG_SESSION_TYPE: "x11", DISPLAY: ":1" }, "linux"),
		).toBe(true);
	});

	it("is false for X11 without a display (headless)", () => {
		expect(isXClientWindowing({ XDG_SESSION_TYPE: "x11" }, "linux")).toBe(false);
	});

	it("is true for XWayland: wayland session, X11-steered Electron", () => {
		expect(
			isXClientWindowing(
				{ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
				"linux",
			),
		).toBe(true);
		expect(
			isXClientWindowing(
				{
					XDG_SESSION_TYPE: "wayland",
					DISPLAY: ":0",
					ELECTRON_OZONE_PLATFORM_HINT: "x11",
				},
				"linux",
			),
		).toBe(true);
	});

	it("is false for native-Wayland Electron", () => {
		const wayland = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
		// Stock Electron (no hint) runs the X11 backend via XWayland even on a
		// Wayland session — only wayland/auto hints (or an explicit
		// --ozone-platform=wayland) put it on native Wayland.
		expect(isXClientWindowing(wayland, "linux")).toBe(true);
		expect(
			isXClientWindowing({ ...wayland, ELECTRON_OZONE_PLATFORM_HINT: "auto" }, "linux"),
		).toBe(false);
		expect(
			isXClientWindowing({ ...wayland, ELECTRON_OZONE_PLATFORM_HINT: "wayland" }, "linux"),
		).toBe(false);
		expect(
			isXClientWindowing(wayland, "linux", ["--ozone-platform=wayland"]),
		).toBe(false);
	});
});

describe("resolveHudWindowMode", () => {
	const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
	const wayland = {
		XDG_SESSION_TYPE: "wayland",
		WAYLAND_DISPLAY: "wayland-0",
		ELECTRON_OZONE_PLATFORM_HINT: "wayland",
	};

	it("picks shape for X clients and grow for native Wayland", () => {
		expect(resolveHudWindowMode(x11, "linux")).toBe("shape");
		expect(resolveHudWindowMode(wayland, "linux")).toBe("grow");
		expect(
			resolveHudWindowMode(
				{ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
				"linux",
			),
		).toBe("shape"); // XWayland
	});

	it("is legacy off Linux", () => {
		expect(resolveHudWindowMode({ DISPLAY: ":0" }, "win32")).toBe("legacy");
	});

	it("lets the dev-only env override force any mode", () => {
		expect(
			resolveHudWindowMode({ ...x11, RECORDLY_FORCE_HUD_WINDOW_MODE: "grow" }, "linux"),
		).toBe("grow");
		expect(
			resolveHudWindowMode({ ...wayland, RECORDLY_FORCE_HUD_WINDOW_MODE: "shape" }, "linux"),
		).toBe("shape");
		expect(
			resolveHudWindowMode({ ...x11, RECORDLY_FORCE_HUD_WINDOW_MODE: "bogus" }, "linux"),
		).toBe("shape"); // invalid values are ignored
	});
});
