import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { spawn } from "node:child_process";
import { readAppSetting, writeAppSetting } from "./appSettingsStore";
import { shouldForceLinuxEgl } from "./gpuSwitches";

const GPU_PROBE_VERDICT_KEY = "gpuProbeVerdict"; // "hardware" | "software" | "inconclusive"
const GPU_RESTART_CHOICE_KEY = "gpuRestartChoice"; // "accepted" | "dismissed"

const PROBE_SETTLE_MS = 1500;
const PROBE_TIMEOUT_MS = 12_000;

export type GpuProbeVerdict = "hardware" | "software" | "inconclusive";

/**
 * Where a locally staged Electron 39 binary would live (see worklog: the
 * detect-and-restart setup is intentionally local-only; packaged builds never
 * ship it). Returns the path when it exists.
 */
export function resolveStagedElectron39Binary(
	appPath: string,
	existsSync: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (platform !== "linux") {
		return null;
	}
	// Resolve against the app path so a relative appPath (dev "electron .")
	// still yields a stable absolute binary for the detached relaunch.
	const candidate = path.resolve(appPath, "build", "electron-39", "electron");
	return existsSync(candidate) ? candidate : null;
}

export function isElectronVersionAtLeast(version: string, major: number): boolean {
	const parsed = Number.parseInt(version, 10);
	return Number.isFinite(parsed) && parsed >= major;
}

export function parseGpuProbeResult(raw: string): GpuProbeVerdict {
	try {
		const parsed = JSON.parse(raw) as { ok?: boolean; renderer?: string };
		const renderer = (parsed.renderer ?? "").toString();
		// Chromium masks WEBGL renderer strings by default; SwiftShader reports
		// "WebKit WebGL" / "SwiftShader" depending on version.
		if (/swiftshader|webkit webgl|llvmpipe|softpipe/i.test(renderer)) {
			return "software";
		}
		return parsed.ok === true ? "hardware" : "software";
	} catch {
		return "inconclusive";
	}
}

const PROBE_PAGE_HTML = "data:text/html,<html><body>recordly-gpu-probe</body></html>";

const PROBE_SCRIPT = `(async () => {
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
	if (!gl) {
		return JSON.stringify({ ok: false, renderer: "", reason: "no-context" });
	}
	let renderer = "";
	const dbg = gl.getExtension("WEBGL_debug_renderer_info");
	if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
	gl.clearColor(0.25, 0.5, 0.75, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);
	const px = new Uint8Array(4);
	gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
	let contextLost = false;
	canvas.addEventListener("webglcontextlost", () => { contextLost = true; });
	await new Promise((resolve) => setTimeout(resolve, ${PROBE_SETTLE_MS}));
	return JSON.stringify({
		ok: !contextLost && px[0] === 64 && px[1] === 128,
		renderer,
		reason: contextLost ? "context-lost" : undefined,
	});
})()`;

/**
 * Renders one real WebGL frame in a hidden window and classifies the result.
 * The decisive signal for the Mesa/AMD Electron 43 bug is the GPU process
 * dying while (or right after) the context is created; a context that comes
 * back software (SwiftShader) is also "software". Exceptions and timeouts are
 * "inconclusive" so a flaky probe never nags a healthy machine.
 */
export async function probeGpuHardwareAcceleration(): Promise<GpuProbeVerdict> {
	let gpuProcessDied = false;
	const onChildProcessGone = (_event: unknown, details: { type?: string }) => {
		if ((details?.type ?? "").toLowerCase().includes("gpu")) {
			gpuProcessDied = true;
		}
	};
	app.on("child-process-gone", onChildProcessGone);

	let raw: string | { timeout: true } | null = null;
	try {
		const win = new BrowserWindow({
			show: false,
			width: 64,
			height: 64,
			webPreferences: { offscreen: true },
		});
		try {
			await win.loadURL(PROBE_PAGE_HTML);
			raw = (await Promise.race([
				win.webContents.executeJavaScript(PROBE_SCRIPT),
				new Promise<{ timeout: true }>((resolve) =>
					setTimeout(() => resolve({ timeout: true }), PROBE_TIMEOUT_MS - PROBE_SETTLE_MS),
				),
			])) as string | { timeout: true };
		} finally {
			win.destroy();
		}
	} catch {
		return "inconclusive";
	} finally {
		app.off("child-process-gone", onChildProcessGone);
	}

	if (typeof raw !== "string") {
		// The renderer never answered — with a dead GPU process that is the
		// expected symptom; on its own it is not enough to convict.
		return gpuProcessDied ? "software" : "inconclusive";
	}
	const verdict = parseGpuProbeResult(raw);
	if (verdict === "software") {
		return "software";
	}
	if (verdict === "hardware" && !gpuProcessDied) {
		return "hardware";
	}
	return "software";
}

export const RELAUNCH_PARENT_PID_ENV = "RECORDLY_RELAUNCH_PARENT_PID";
const DEV_RELAWIT_WRAPPER_SUFFIX = "dev-with-electron.mjs";

/**
 * Dev-mode relaunch: vite-plugin-electron kills the vite dev server when this
 * (40+) instance exits, so a plainly spawned child would inherit a dead
 * renderer URL. Instead, spawn a detached wrapper that waits for the old dev
 * server's port to disappear, then brings the whole stack back up on the
 * staged Electron 39 (logs to the relaunch log).
 */
export function relaunchDevStackIntoStagedElectron39(
	binaryPath: string,
	appPath: string,
	devServerUrl: string,
	spawnFn: typeof spawn = spawn,
	quit: () => void = () => app.quit(),
): boolean {
	try {
		const wrapperPath = path.join(appPath, "scripts", DEV_RELAWIT_WRAPPER_SUFFIX);
		const logPath = path.join(app.getPath("userData"), "electron39-relaunch.log");
		const logFd = fs.openSync(logPath, "a");
		fs.writeSync(logFd, `\n===== dev relaunch at ${new Date().toISOString()} =====\n`);
		const child = spawnFn(
			process.execPath,
			[wrapperPath, "--await-port-free", devServerUrl],
			{
				detached: true,
				stdio: ["ignore", logFd, logFd],
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					ELECTRON_OVERRIDE_DIST_PATH: path.dirname(binaryPath),
				},
				cwd: appPath,
			},
		);
		child.unref();
		quit();
		return true;
	} catch (error) {
		console.warn("Failed to relaunch dev stack into staged Electron 39:", error);
		return false;
	}
}

/**
 * Spawns the staged Electron 39 binary detached with this same app, then quits
 * the current (40+) instance. Returns false when the child could not start.
 * The child's output goes to <userData>/electron39-relaunch.log so a failed
 * handoff is diagnosable (the old instance is quitting while the child starts,
 * which is inherently racy — see the lock-retry in main.ts).
 */
export function relaunchIntoStagedElectron39(
	binaryPath: string,
	appPath: string,
	argv: string[],
	spawnFn: typeof spawn = spawn,
	quit: () => void = () => app.quit(),
): boolean {
	try {
		const forwardedArgs = argv
			.slice(1)
			.filter((arg) => arg !== appPath && arg !== ".");
		let stdio: ("ignore" | number)[] = ["ignore", "ignore", "ignore"];
		try {
			const logPath = path.join(app.getPath("userData"), "electron39-relaunch.log");
			const logFd = fs.openSync(logPath, "a");
			fs.writeSync(logFd, `\n===== relaunch at ${new Date().toISOString()} =====\n`);
			stdio = ["ignore", logFd, logFd];
		} catch (error) {
			console.warn("Failed to open relaunch log, continuing with stdio ignore:", error);
		}
		const child = spawnFn(binaryPath, [...forwardedArgs, appPath], {
			detached: true,
			stdio,
			env: {
				...process.env,
				[RELAUNCH_PARENT_PID_ENV]: String(process.pid),
			},
		});
		child.unref();
		quit();
		return true;
	} catch (error) {
		console.warn("Failed to relaunch into staged Electron 39:", error);
		return false;
	}
}

async function offerElectron39Restart(
	stagedBinaryPath: string,
	devServerUrl?: string,
): Promise<void> {
	const previousChoice = readAppSetting(GPU_RESTART_CHOICE_KEY);
	if (previousChoice === "accepted") {
		// They already chose the fast engine — relaunch without asking again.
		if (devServerUrl) {
			relaunchDevStackIntoStagedElectron39(stagedBinaryPath, app.getAppPath(), devServerUrl);
		} else {
			relaunchIntoStagedElectron39(stagedBinaryPath, app.getAppPath(), process.argv);
		}
		return;
	}
	if (previousChoice === "dismissed") {
		return;
	}

	const { response, checkboxChecked } = await dialog.showMessageBox({
		type: "warning",
		title: "Recordly — faster graphics available",
		message: devServerUrl
			? "Your graphics driver doesn't get along with this engine, so Recordly's interface is running in software mode (slow).\n\nRestart the dev stack on the staged Electron 39? This dev session closes and a fresh one starts automatically (its output goes to electron39-relaunch.log in the user-data folder)."
			: "Your graphics driver doesn't get along with this engine, so Recordly's interface is running in software mode (slow).\n\nA faster engine is already set up on this machine. Restart Recordly with it?",
		checkboxLabel: "Don't ask again",
		checkboxChecked: false,
		buttons: devServerUrl
			? ["Switch dev stack to Electron 39", "Keep software mode"]
			: ["Restart once for fast graphics", "Keep software mode"],
		defaultId: 0,
		cancelId: 1,
	});

	if (response === 0) {
		writeAppSetting(GPU_RESTART_CHOICE_KEY, "accepted");
		if (devServerUrl) {
			relaunchDevStackIntoStagedElectron39(stagedBinaryPath, app.getAppPath(), devServerUrl);
		} else {
			relaunchIntoStagedElectron39(stagedBinaryPath, app.getAppPath(), process.argv);
		}
		return;
	}
	if (checkboxChecked) {
		writeAppSetting(GPU_RESTART_CHOICE_KEY, "dismissed");
	}
}

/**
 * Detect-once flow for the Linux Mesa/AMD Electron 40+ GL bug (see worklog
 * "SHELVED — GPU-accelerated exports"): probe hardware GL once, remember the
 * verdict, and offer a restart into the staged Electron 39 binary when the
 * machine is affected. Healthy machines never see any of this.
 */
export async function maybeProbeGpuAndOfferElectron39(
	env: NodeJS.ProcessEnv = process.env,
	electronVersion: string = process.versions.electron ?? "",
): Promise<GpuProbeVerdict | null> {
	if (process.platform !== "linux") {
		return null;
	}
	if (!isElectronVersionAtLeast(electronVersion, 40)) {
		// Already on the fallback engine (or a future fixed release below 40).
		return null;
	}
	if (!shouldForceLinuxEgl(env)) {
		// Wayland sessions use a different GL path; the bug is X11-specific.
		return null;
	}
	const devServerUrl = env.VITE_DEV_SERVER_URL;

	const existingVerdict = readAppSetting(GPU_PROBE_VERDICT_KEY);
	if (existingVerdict === "hardware") {
		return null;
	}

	const stagedBinaryPath = resolveStagedElectron39Binary(app.getAppPath());
	if (existingVerdict !== "software" || !stagedBinaryPath) {
		// No persisted verdict yet (or nothing to restart into): probe now.
		const verdict = await probeGpuHardwareAcceleration();
		console.info(`[gpu-fallback] probe verdict: ${verdict}`);
		writeAppSetting(GPU_PROBE_VERDICT_KEY, verdict);
		if (verdict !== "software") {
			return verdict;
		}
		if (!stagedBinaryPath) {
			console.info(
				"[gpu-fallback] software rendering detected, but no staged Electron 39 binary found (build/electron-39/).",
			);
			return verdict;
		}
	}

	await offerElectron39Restart(stagedBinaryPath, devServerUrl);
	return "software";
}
