import { describe, expect, it } from "vitest";
import { normalizeCloudEndpoint, parseCloudShareTicket } from "../cloudShareContract";

describe("cloud share contract", () => {
	it("accepts only Recordly production and local development endpoints", () => {
		expect(normalizeCloudEndpoint("https://videos.recordly.dev/api/upload#ignored")).toBe(
			"https://videos.recordly.dev/api/upload",
		);
		expect(normalizeCloudEndpoint("http://localhost:8787/api/upload")).toBe(
			"http://localhost:8787/api/upload",
		);
	});

	it("normalizes a Voom upload ticket and derives its metadata endpoint", () => {
		expect(
			parseCloudShareTicket({
				shareCode: "abc123",
				uploadURL: "http://localhost:8787/api/upload-data/abc123",
				shareURL: "http://localhost:8787/s/abc123",
			}),
		).toEqual({
			uploadUrl: "http://localhost:8787/api/upload-data/abc123",
			shareUrl: "http://localhost:8787/s/abc123",
			shareCode: "abc123",
			method: "PUT",
			headers: {},
			finalizeUrl: "http://localhost:8787/api/metadata/abc123",
		});
	});

	it("rejects insecure and untrusted remote endpoints", () => {
		expect(() => normalizeCloudEndpoint("http://share.example.com/api/shares")).toThrow(
			"only allowed through the Recordly service",
		);
		expect(() => normalizeCloudEndpoint("https://share.example.com/api/upload")).toThrow(
			"only allowed through the Recordly service",
		);
		expect(() => normalizeCloudEndpoint("https://videos.recordly.dev/api/other")).toThrow(
			"endpoint is invalid",
		);
	});

	it("normalizes a presigned PUT ticket", () => {
		expect(
			parseCloudShareTicket({
				uploadUrl: "https://storage.example.com/upload",
				shareUrl: "https://share.example.com/s/123",
				headers: { "x-test": "value" },
			}),
		).toEqual({
			uploadUrl: "https://storage.example.com/upload",
			shareUrl: "https://share.example.com/s/123",
			shareCode: undefined,
			method: "PUT",
			headers: { "x-test": "value" },
			finalizeUrl: undefined,
		});
	});

	it("rejects unsupported methods and malformed headers", () => {
		expect(() =>
			parseCloudShareTicket({
				uploadUrl: "https://storage.example.com/upload",
				shareUrl: "https://share.example.com/s/123",
				method: "POST",
			}),
		).toThrow("presigned PUT");
		expect(() =>
			parseCloudShareTicket({
				uploadUrl: "https://storage.example.com/upload",
				shareUrl: "https://share.example.com/s/123",
				headers: { invalid: 42 },
			}),
		).toThrow("must be strings");
		expect(() =>
			parseCloudShareTicket({
				uploadUrl: "https://storage.example.com/upload",
				shareUrl: "https://share.example.com/s/123",
				headers: { authorization: "Bearer exfiltrate-me" },
			}),
		).toThrow("not allowed");
	});

	it("rejects an insecure remote upload URL", () => {
		expect(() =>
			parseCloudShareTicket({
				uploadUrl: "http://storage.example.com/upload",
				shareUrl: "https://share.example.com/s/123",
			}),
		).toThrow("uploadUrl must use HTTPS");
	});
});
