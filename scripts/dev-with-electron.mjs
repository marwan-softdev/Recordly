#!/usr/bin/env node
// Local dev launcher: run the dev stack on a staged Electron build instead of
// node_modules/electron (whose GL path is broken on some Linux drivers — see
// LINUX-CURSOR-WORKLOG.md "Electron 39 fallback").
//
//   npm run dev                       # stock Electron (43), or 39 directly when
//                                     #   this machine's GL verdict was "software"
//                                     #   and the switch was accepted
//   npm run dev:39                    # require the staged Electron 39 (error if missing)
//   npm run dev:43                    # stock, ignores the accepted switch
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
const requireStaged = argv.includes("--require-staged");
const forceStock = argv.includes("--restore");

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
	// Explicit dev:39 request.
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

const isWindows = process.platform === "win32";
const viteBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "vite.CMD" : "vite");

const child = spawn(viteBin, ["--config", "vite.config.ts"], {
	stdio: "inherit",
	env: process.env,
	cwd: projectRoot,
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
