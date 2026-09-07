import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLinuxCaptureOutputBuffer, setLinuxCaptureStopRequested } from "../state";
import { waitForLinuxCaptureStart, waitForLinuxCaptureStop } from "./linux";

vi.mock("electron", () => ({
	app: {
		getPath: () => "/tmp/RecordlyTest",
	},
	BrowserWindow: {
		getAllWindows: () => [],
	},
}));

class FakeCaptureProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	killed = false;

	kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

describe("waitForLinuxCaptureStart", () => {
	it("rejects with buffered output when ffmpeg exits before starting", async () => {
		const proc = new FakeCaptureProcess();
		setLinuxCaptureOutputBuffer("Unable to open display :0\n");

		const started = waitForLinuxCaptureStart(
			proc as unknown as Parameters<typeof waitForLinuxCaptureStart>[0],
		);
		proc.emit("exit", 1);

		await expect(started).rejects.toThrow("Unable to open display :0");
	});

	it("resolves once ffmpeg stays alive through the readiness window", async () => {
		const proc = new FakeCaptureProcess();

		await expect(
			waitForLinuxCaptureStart(
				proc as unknown as Parameters<typeof waitForLinuxCaptureStart>[0],
			),
		).resolves.toBeUndefined();
	});
});

describe("waitForLinuxCaptureStop", () => {
	beforeEach(() => {
		setLinuxCaptureOutputBuffer("");
		setLinuxCaptureStopRequested(false);
	});

	it("resolves the output path when ffmpeg quits cleanly", async () => {
		const proc = new FakeCaptureProcess();
		const outputPath = path.join(tmpdir(), `recordly-linux-test-${Date.now()}.mp4`);
		await fs.writeFile(outputPath, "fake");

		const stopped = waitForLinuxCaptureStop(
			proc as unknown as Parameters<typeof waitForLinuxCaptureStop>[0],
			outputPath,
			1000,
		);
		proc.emit("close", 0);

		await expect(stopped).resolves.toBe(outputPath);
		expect(proc.kill).not.toHaveBeenCalled();
		await fs.rm(outputPath, { force: true });
	});

	it("rejects with buffered output when the output file is missing", async () => {
		const proc = new FakeCaptureProcess();
		setLinuxCaptureOutputBuffer("Encoder error: something broke");

		const stopped = waitForLinuxCaptureStop(
			proc as unknown as Parameters<typeof waitForLinuxCaptureStop>[0],
			path.join(tmpdir(), `recordly-missing-${Date.now()}.mp4`),
			1000,
		);
		proc.emit("close", 1);

		await expect(stopped).rejects.toThrow("Encoder error: something broke");
	});

	it("kills ffmpeg and rejects when stop never completes", async () => {
		const proc = new FakeCaptureProcess();

		await expect(
			waitForLinuxCaptureStop(
				proc as unknown as Parameters<typeof waitForLinuxCaptureStop>[0],
				path.join(tmpdir(), `recordly-never-${Date.now()}.mp4`),
				5,
			),
		).rejects.toThrow("Timed out waiting for native Linux capture to stop");
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});
});
