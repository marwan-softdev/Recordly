#!/usr/bin/env node
// Local dev launcher: run the dev stack on a staged Electron build instead of
// node_modules/electron (whose GL path is broken on some Linux drivers — see
// LINUX-CURSOR-WORKLOG.md "Electron 39 fallback").
//
//   npm run dev                       # stock Electron (43) — the gpu-fallback probe
//                                     #   offers the switch when the GPU path is broken;
//                                     #   once the switch was accepted, starts on 39 directly
//   npm run dev:39                    # require the staged Electron 39 (error if missing)
//   npm run dev:43                    # stock, ignores the accepted switch
//
// The gpu-fallback restart flow also calls this script detached with:
//   --await-port-free <url>           # wait for the previous dev server to die first
//                                     # (implies --require-staged)
//
// Must run before `vite` so the plugin spawns the overridden binary.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagedBinary = path.join(projectRoot, "build", "electron-39", "electron");
const stagedDistDir = path.dirname(stagedBinary);

const argv = process.argv.slice(2);
const requireStaged = argv.includes("--require-staged") || argv.includes("--await-port-free");
const forceStock = argv.includes("--restore");
const awaitPortFreeIndex = argv.indexOf("--await-port-free");
const awaitPortFreeUrl =
	awaitPortFreeIndex >= 0 ? (argv[awaitPortFreeIndex + 1] ?? "") : "";

// Skips the pointless 43 phase once this machine's GL verdict is "software"
// and the switch was accepted — the keys live in the dev profile's
// app-settings.json (written when the probe/offer machinery was still in the
// app; since its removal nothing writes them, so on a fresh profile either
// set them manually or use `npm run dev:39`). Dev-only naming: the dev
// profile's userData dir is ~/.config/Recordly-dev.
function hasAcceptedElectron39Switch() {
	if (process.platform !== "linux") return false;
	try {
		const settingsPath = path.join(
			homedir(),
			".config",
			"Recordly-dev",
			"app-settings.json",
		);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		return settings.gpuProbeVerdict === "software" && settings.gpuRestartChoice === "accepted";
	} catch {
		return false;
	}
}

if (requireStaged) {
	// Explicit dev:39, or the gpu-fallback relaunch (--await-port-free).
	if (!existsSync(stagedBinary)) {
		console.error(
			`[dev-with-electron] Staged Electron not found at ${stagedBinary}.\n` +
				"Download and extract it first, e.g.:\n" +
				"  curl -L -o /tmp/e39.zip https://github.com/electron/electron/releases/download/v39.2.7/electron-v39.2.7-linux-x64.zip\n" +
				"  mkdir -p build/electron-39 && unzip /tmp/e39.zip -d build/electron-39",
		);
		process.exit(1);
	}
	// getElectronPath() joins this dir with path.txt's relative name.
	process.env.ELECTRON_OVERRIDE_DIST_PATH = stagedDistDir;
	console.log(`[dev-with-electron] Using staged Electron: ${stagedBinary}`);
} else if (!forceStock && hasAcceptedElectron39Switch() && existsSync(stagedBinary)) {
	process.env.ELECTRON_OVERRIDE_DIST_PATH = stagedDistDir;
	console.log(
		"[dev-with-electron] starting directly on Electron 39 (switch already accepted on this machine)",
	);
} else {
	delete process.env.ELECTRON_OVERRIDE_DIST_PATH;
	console.log("[dev-with-electron] Using the stock node_modules/electron binary (43).");
}

async function waitForDevServerToDisappear(url, timeoutMs = 60_000) {
	if (!url) return;
	const deadline = Date.now() + timeoutMs;
	let announced = false;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { method: "HEAD" });
			if (!response.ok) return; // server gone or answering with an error
		} catch {
			return; // connection refused — the old server is gone
		}
		if (!announced) {
			announced = true;
			console.log(`[dev-with-electron] Waiting for the previous dev server (${url}) to shut down...`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	console.warn("[dev-with-electron] Previous dev server still up after timeout; starting anyway.");
}

// This wrapper itself may be running under the Electron binary as Node
// (ELECTRON_RUN_AS_NODE=1 set by the gpu-fallback relaunch). That flag must
// NOT reach the vite/electron children or they start as plain Node too.
delete process.env.ELECTRON_RUN_AS_NODE;

const isWindows = process.platform === "win32";
const viteBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "vite.CMD" : "vite");

const startVite = () => {
	const child = spawn(viteBin, ["--config", "vite.config.ts"], {
		stdio: "inherit",
		env: process.env,
		cwd: projectRoot,
	});
	child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
};

if (awaitPortFreeUrl) {
	// Detached restart flow: the old stack is shutting down as we start.
	waitForDevServerToDisappear(awaitPortFreeUrl).then(startVite);
} else {
	startVite();
}
