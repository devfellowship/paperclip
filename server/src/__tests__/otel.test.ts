import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  __resetForTests,
  getTracer,
  initTelemetry,
  redactAttrs,
} from "../otel.js";

const ENV_KEYS = [
  "PAPERCLIP_TELEMETRY_ENABLED",
  "LANGFUSE_HOST",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "PAPERCLIP_VERSION",
  "NODE_ENV",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  __resetForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetForTests();
});

describe("redactAttrs", () => {
  it("redacts known sensitive keys (case insensitive)", () => {
    const input = {
      authorization: "Bearer abc",
      Authorization: "Bearer abc",
      api_key: "sk-xxx",
      "API-KEY": "sk-xxx",
      apikey: "sk-xxx",
      token: "tok",
      password: "hunter2",
      secret: "s",
      bearer: "b",
      jwt: "j",
      pat: "p",
      "x-api-key": "k",
    };
    const out = redactAttrs(input);
    for (const k of Object.keys(input)) {
      expect(out[k as keyof typeof out]).toBe("[REDACTED]");
    }
  });

  it("does not redact unrelated keys", () => {
    const input = {
      user_id: "u1",
      auth_flow_step: "login",
      api_url: "https://x",
      description: "no secrets here",
      count: 42,
      isEnabled: true,
    };
    const out = redactAttrs(input);
    expect(out).toEqual(input);
  });

  it("truncates string values larger than 4KB", () => {
    const big = "a".repeat(5000);
    const out = redactAttrs({ payload: big, small: "hi" });
    const payload = out.payload as string;
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThan(big.length);
    expect(payload.startsWith("a".repeat(4096))).toBe(true);
    expect(payload).toMatch(/\[\+\d+b truncated\]$/);
    expect(out.small).toBe("hi");
  });

  it("leaves short strings untouched", () => {
    const out = redactAttrs({ s: "a".repeat(4096) });
    expect(out.s).toBe("a".repeat(4096));
  });

  it("returns a new object (shallow clone)", () => {
    const input = { a: 1 };
    const out = redactAttrs(input);
    expect(out).not.toBe(input);
    expect(out).toEqual({ a: 1 });
  });
});

describe("initTelemetry", () => {
  it("is a no-op when PAPERCLIP_TELEMETRY_ENABLED=false", () => {
    process.env.PAPERCLIP_TELEMETRY_ENABLED = "false";
    process.env.LANGFUSE_PUBLIC_KEY = "pk";
    process.env.LANGFUSE_SECRET_KEY = "sk";
    expect(() => initTelemetry()).not.toThrow();
    // Tracer should still be retrievable — it will be a no-op tracer
    // since no SDK is registered as a global provider.
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    const span = tracer.startSpan("test");
    // Default tracer returns a non-recording span when no SDK is registered.
    expect(typeof span.end).toBe("function");
    span.end();
  });

  it("is a no-op when Langfuse creds missing AND OTel endpoint missing", () => {
    process.env.PAPERCLIP_TELEMETRY_ENABLED = "true";
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    // Explicit empty OTEL endpoint — strip default fallback
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
    expect(() => initTelemetry()).not.toThrow();
    const tracer = getTracer();
    expect(tracer).toBeDefined();
  });

  it("is idempotent — second call is a no-op", () => {
    process.env.PAPERCLIP_TELEMETRY_ENABLED = "false";
    initTelemetry();
    // Second call must not throw and must not attempt re-init.
    expect(() => initTelemetry()).not.toThrow();
  });

  it("getTracer() returns a tracer even before init", () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    const span = tracer.startSpan("pre-init");
    span.end();
  });
});
