import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => "/app",
		getPath: () => "/tmp/recordly-test-user-data",
		on: vi.fn(),
		off: vi.fn(),
		quit: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	dialog: { showMessageBox: vi.fn() },
}));

import {
	isElectronVersionAtLeast,
	parseGpuProbeResult,
	relaunchIntoStagedElectron39,
	resolveStagedElectron39Binary,
} from "./gpuFallback39";

describe("isElectronVersionAtLeast", () => {
	it("parses the major version", () => {
		expect(isElectronVersionAtLeast("43.1.0", 40)).toBe(true);
		expect(isElectronVersionAtLeast("39.2.7", 40)).toBe(false);
	});

	it("treats unparseable versions as below the threshold", () => {
		expect(isElectronVersionAtLeast("", 40)).toBe(false);
		expect(isElectronVersionAtLeast("unknown", 40)).toBe(false);
	});
});

describe("resolveStagedElectron39Binary", () => {
	it("finds the staged binary on linux", () => {
		expect(
			resolveStagedElectron39Binary("/app", (p) => p === "/app/build/electron-39/electron", "linux"),
		).toBe("/app/build/electron-39/electron");
	});

	it("returns null when nothing is staged", () => {
		expect(resolveStagedElectron39Binary("/app", () => false, "linux")).toBeNull();
	});

	it("returns null off linux", () => {
		expect(resolveStagedElectron39Binary("/app", () => true, "darwin")).toBeNull();
	});
});

describe("parseGpuProbeResult", () => {
	it("classifies a hardware result", () => {
		expect(
			parseGpuProbeResult(
				JSON.stringify({ ok: true, renderer: "ANGLE (AMD Radeon Graphics, OpenGL 4.6)" }),
			),
		).toBe("hardware");
	});

	it("classifies software renderers as software", () => {
		expect(parseGpuProbeResult(JSON.stringify({ ok: true, renderer: "WebKit WebGL" }))).toBe(
			"software",
		);
		expect(
			parseGpuProbeResult(JSON.stringify({ ok: true, renderer: "SwiftShader (LLVM)" })),
		).toBe("software");
	});

	it("classifies a refused context as software", () => {
		expect(parseGpuProbeResult(JSON.stringify({ ok: false, renderer: "" }))).toBe("software");
	});

	it("is inconclusive on garbage", () => {
		expect(parseGpuProbeResult("not json")).toBe("inconclusive");
	});
});

describe("relaunchIntoStagedElectron39", () => {
	it("spawns the staged binary with the app path and extra args, then quits", () => {
		const child = { unref: vi.fn() };
		const spawnFn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
		const quit = vi.fn();
		const ok = relaunchIntoStagedElectron39(
			"/app/build/electron-39/electron",
			"/app",
			["/usr/electron", "--no-sandbox", "."],
			spawnFn,
			quit,
		);
		expect(ok).toBe(true);
		expect(spawnFn).toHaveBeenCalledWith(
			"/app/build/electron-39/electron",
			["--no-sandbox", "/app"],
			{
				detached: true,
				stdio: expect.anything(),
				env: expect.objectContaining({ RECORDLY_RELAUNCH_PARENT_PID: expect.any(String) }),
			},
		);
		expect(quit).toHaveBeenCalled();
	});

	it("returns false when spawn throws", () => {
		const spawnFn = vi.fn(() => {
			throw new Error("boom");
		}) as unknown as typeof import("node:child_process").spawn;
		const quit = vi.fn();
		expect(
			relaunchIntoStagedElectron39("/x", "/app", ["."], spawnFn, quit),
		).toBe(false);
		expect(quit).not.toHaveBeenCalled();
	});
});
