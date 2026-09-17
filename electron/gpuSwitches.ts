export interface GpuSwitches {
	useAngle?: string;
	useGl?: string;
	disableFeatures?: string[];
	switches?: string[];
}

function normalizeLinuxWindowSystem(value: string | undefined): "wayland" | "x11" | null {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "wayland" || normalized === "x11") {
		return normalized;
	}

	return null;
}

function getForcedLinuxWindowSystem(env: NodeJS.ProcessEnv): "wayland" | "x11" | null {
	return (
		normalizeLinuxWindowSystem(env.OZONE_PLATFORM) ??
		normalizeLinuxWindowSystem(env.ELECTRON_OZONE_PLATFORM_HINT)
	);
}

export function shouldForceLinuxEgl(env: NodeJS.ProcessEnv): boolean {
	const forcedWindowSystem = getForcedLinuxWindowSystem(env);
	if (forcedWindowSystem === "wayland") {
		return false;
	}
	if (forcedWindowSystem === "x11") {
		return true;
	}

	const sessionType = env.XDG_SESSION_TYPE?.toLowerCase();
	if (sessionType === "wayland") {
		return false;
	}
	if (sessionType === "x11") {
		return true;
	}

	return !env.WAYLAND_DISPLAY;
}

export function getGpuSwitches(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv = process.env,
	electronVersion: string = process.versions.electron ?? "",
): GpuSwitches {
	if (platform === "darwin") {
		return {
			useAngle: "metal",
			disableFeatures: ["MacCatapLoopbackAudioForScreenShare"],
		};
	}

	if (platform === "win32") {
		return { useAngle: "d3d11" };
	}

	if (platform === "linux") {
		const majorVersion = Number.parseInt(electronVersion, 10);
		// Electron 39's default GL path works with hardware acceleration on
		// Mesa/AMD (verified live: unmasked renderer "ANGLE (AMD Radeon
		// radeonsi renoir, OpenGL 4.6)", stable context, no GPU-process
		// exits) — where 43's path crashes with gbm_bo_import errors and
		// needs the software-GL fallback switches below. Note: --use-gl=egl
		// (the old AppImage combo) is actively rejected by 39's gl_factory;
		// no switch at all is the correct configuration.
		if (Number.isFinite(majorVersion) && majorVersion < 40) {
			return {};
		}
		return {
			...(shouldForceLinuxEgl(env)
				? {
						useGl: "angle",
						useAngle: "swiftshader",
						// Electron 43 requires an explicit opt-in before software
						// WebGL is granted; without it WebGL contexts are refused
						// entirely when the hardware path is unavailable.
						switches: ["enable-unsafe-swiftshader"],
					}
				: {}),
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		};
	}

	return {};
}
