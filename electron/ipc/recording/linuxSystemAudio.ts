import type { ChildProcessByStdio } from "node:child_process";
import type { Writable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";

type SystemAudioProcess = ChildProcessByStdio<Writable, null, null>;

const execFileAsync = promisify(execFile);

const PACTL_TIMEOUT_MS = 5000;

export type LinuxSystemAudioAvailability = {
	available: boolean;
	/** PulseAudio/PipeWire source to record, e.g. "<default-sink>.monitor". */
	sourceName?: string;
	reason?: "no-pulse-device" | "no-monitor-source";
};

export function parseDefaultSinkName(pactlOutput: string): string | null {
	const match = pactlOutput.match(/^(\S+)\s*$/m);
	return match?.[1] ?? null;
}

export function parsePactlSourceNames(pactlListShortOutput: string): string[] {
	return pactlListShortOutput
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\t+/)[1])
		.filter((name): name is string => Boolean(name));
}

export function resolveMonitorSourceName(
	defaultSink: string | null,
	sourceNames: string[],
): string | null {
	const expected = defaultSink ? `${defaultSink}.monitor` : null;
	if (expected && sourceNames.includes(expected)) {
		return expected;
	}
	return sourceNames.find((sourceName) => sourceName.endsWith(".monitor")) ?? null;
}

let probeCache: Promise<LinuxSystemAudioAvailability> | null = null;

export function resetLinuxSystemAudioProbe() {
	probeCache = null;
}

/**
 * Resolves the PulseAudio source that mirrors the default output ("monitor").
 * pactl is optional: without it we optimistically use the Pulse special name
 * @DEFAULT_MONITOR@, which modern PulseAudio/PipeWire servers resolve.
 */
export async function getLinuxSystemAudioCapture(): Promise<LinuxSystemAudioAvailability> {
	if (!probeCache) {
		probeCache = probeLinuxSystemAudioCapture().catch((error) => {
			probeCache = null;
			throw error;
		});
	}
	return probeCache;
}

async function probeLinuxSystemAudioCapture(): Promise<LinuxSystemAudioAvailability> {
	let defaultSink: string | null = null;
	let sourceNames: string[] = [];
	let pactlSucceeded = false;

	try {
		const [sinkResult, sourcesResult] = await Promise.all([
			execFileAsync("pactl", ["get-default-sink"], { timeout: PACTL_TIMEOUT_MS }),
			execFileAsync("pactl", ["list", "short", "sources"], { timeout: PACTL_TIMEOUT_MS }),
		]);
		defaultSink = parseDefaultSinkName(sinkResult.stdout.trim());
		sourceNames = parsePactlSourceNames(sourcesResult.stdout);
		pactlSucceeded = true;
	} catch {
		// pactl missing or failed — fall through to the special-name fallback.
	}

	try {
		const devices = await execFileAsync("ffmpeg", ["-hide_banner", "-devices"], {
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});
		if (!/\bpulse\b/.test(devices.stdout)) {
			return { available: false, reason: "no-pulse-device" };
		}
	} catch {
		return { available: false, reason: "no-pulse-device" };
	}

	const resolved = resolveMonitorSourceName(defaultSink, sourceNames);
	if (resolved) {
		return { available: true, sourceName: resolved };
	}
	if (pactlSucceeded) {
		// The sound server answered but exposes no monitor source at all.
		return { available: false, reason: "no-monitor-source" };
	}
	return { available: true, sourceName: "@DEFAULT_MONITOR@" };
}

export function buildSystemAudioArgs(sourceName: string, outputPath: string): string[] {
	return [
		"-y",
		"-hide_banner",
		"-nostdin",
		"-f",
		"pulse",
		"-i",
		sourceName,
		"-ac",
		"2",
		"-ar",
		"48000",
		"-c:a",
		"pcm_s16le",
		outputPath,
	];
}

const AUDIO_START_READINESS_MS = 900;
const AUDIO_STOP_TIMEOUT_MS = 15_000;

/**
 * Starts one system-audio segment. Mirrors the video segment lifecycle 1:1 so
 * pause boundaries cut both streams at the same wall-clock moments.
 */
export function startLinuxSystemAudioSegment(
	sourceName: string,
	segmentPath: string,
): Promise<SystemAudioProcess> {
	const proc = spawn(getFfmpegBinaryPath(), buildSystemAudioArgs(sourceName, segmentPath), {
		stdio: ["pipe", "ignore", "ignore"],
	}) as SystemAudioProcess;

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			proc.off("exit", onExit);
			proc.off("error", onError);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(proc);
		}, AUDIO_START_READINESS_MS);
		const onExit = (code: number | null) => {
			cleanup();
			reject(
				new Error(
					`System audio capture exited before recording started (code ${code ?? "unknown"})`,
				),
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		proc.once("error", onError);
		proc.once("exit", onExit);
	});
}

export function stopLinuxSystemAudioSegment(
	proc: SystemAudioProcess,
	segmentPath: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const timer = setTimeout(() => {
			finish(() => {
				try {
					if (!proc.killed) proc.kill();
				} catch {
					// already gone
				}
				reject(new Error("Timed out waiting for system audio capture to stop"));
			});
		}, AUDIO_STOP_TIMEOUT_MS);
		const onClose = (code: number | null) => {
			finish(async () => {
				try {
					await fs.access(segmentPath);
					resolve(segmentPath);
				} catch {
					reject(
						new Error(
							`System audio capture exited without output (code ${code ?? "unknown"})`,
						),
					);
				}
			});
		};
		const onError = (error: Error) => {
			finish(() => {
				reject(error);
			});
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.off("close", onClose);
			proc.off("error", onError);
		};
		proc.once("close", onClose);
		proc.once("error", onError);
		try {
			proc.stdin.write("q\n");
		} catch (error) {
			finish(() => {
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		}
	});
}
