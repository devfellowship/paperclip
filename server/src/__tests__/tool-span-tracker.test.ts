import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.useFakeTimers();

// Collect all created spans for assertions.
const createdSpans: MockSpan[] = [];

class MockSpan {
  name: string;
  attrs: Record<string, unknown> = {};
  status: { code: number; message?: string } | null = null;
  ended = false;

  constructor(name: string) {
    this.name = name;
    createdSpans.push(this);
  }

  setAttribute(key: string, value: unknown) {
    this.attrs[key] = value;
  }

  setAttributes(attrs: Record<string, unknown>) {
    Object.assign(this.attrs, attrs);
  }

  setStatus(status: { code: number; message?: string }) {
    this.status = status;
  }

  recordException(_err: Error) {
    // no-op
  }

  end() {
    this.ended = true;
  }
}

const mockTracer = {
  startSpan: vi.fn((name: string, options?: { attributes?: Record<string, unknown> }) => {
    const span = new MockSpan(name);
    if (options?.attributes) {
      Object.assign(span.attrs, options.attributes);
    }
    return span;
  }),
};

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...mod,
    trace: {
      ...mod.trace,
      getTracer: vi.fn(() => mockTracer),
    },
    context: {
      ...mod.context,
      active: vi.fn(() => mod.context.active()),
    },
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { ToolSpanTracker } from "../services/heartbeat.js";

describe("ToolSpanTracker", () => {
  beforeEach(() => {
    createdSpans.length = 0;
    mockTracer.startSpan.mockClear();
  });

  afterEach(() => {
    createdSpans.length = 0;
  });

  function assistantLine(content: unknown[]) {
    return JSON.stringify({ type: "assistant", message: { content } });
  }

  function userLine(content: unknown[]) {
    return JSON.stringify({ type: "user", message: { content } });
  }

  it("opens and closes a span for a tool_use / tool_result pair", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
    ]) + "\n");

    expect(createdSpans).toHaveLength(1);
    const span = createdSpans[0];
    expect(span.name).toBe("tool:Read");
    expect(span.attrs["tool.name"]).toBe("Read");
    expect(span.attrs["tool.use_id"]).toBe("t1");
    expect(span.attrs["tool.input"]).toContain("file_path");
    expect(span.ended).toBe(false);

    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hello" }], is_error: false },
    ]) + "\n");

    expect(span.ended).toBe(true);
    expect(span.attrs["tool.paired"]).toBe(true);
    expect(span.attrs["tool.is_error"]).toBe(false);
    expect(span.attrs["tool.output"]).toContain("hello");
    expect(span.attrs["tool.output_size_bytes"]).toBeGreaterThan(0);
  });

  it("ignores chunks when disabled", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, false);
    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");
    expect(createdSpans).toHaveLength(0);
  });

  it("ignores stderr chunks", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);
    tracker.processChunk("stderr", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");
    expect(createdSpans).toHaveLength(0);
  });

  it("marks span as error when tool_result has is_error=true", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "exit 1" } },
    ]) + "\n");

    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t1", content: "err", is_error: true },
    ]) + "\n");

    const span = createdSpans[0];
    expect(span.ended).toBe(true);
    expect(span.status).toEqual({ code: 2, message: "tool_error" });
    expect(span.attrs["tool.is_error"]).toBe(true);
  });

  it("handles multiple interleaved tool calls", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: { a: 1 } },
      { type: "tool_use", id: "t2", name: "Edit", input: { b: 2 } },
    ]) + "\n");

    expect(createdSpans).toHaveLength(2);

    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t2", content: "ok2", is_error: false },
    ]) + "\n");

    expect(createdSpans[0].ended).toBe(false);
    expect(createdSpans[1].ended).toBe(true);

    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t1", content: "ok1", is_error: false },
    ]) + "\n");

    expect(createdSpans[0].ended).toBe(true);
  });

  it("dedupes duplicate tool_use ids", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    expect(createdSpans).toHaveLength(1);
  });

  it("no-ops on tool_result without matching tool_use", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "ghost", content: "ok", is_error: false },
    ]) + "\n");

    expect(createdSpans).toHaveLength(0);
  });

  it("finalizes unpaired spans as orphan", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    const span = createdSpans[0];
    expect(span.ended).toBe(false);

    tracker.finalize();

    expect(span.ended).toBe(true);
    expect(span.status).toEqual({ code: 2, message: "tool_result_missing" });
    expect(span.attrs["tool.paired"]).toBe(false);
    expect(span.attrs["tool.status"]).toBe("orphan");
  });

  it("sets output_size_bytes to the UTF-8 byte length of the output string", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    const emojiOutput = "hello 🌍";
    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t1", content: emojiOutput, is_error: false },
    ]) + "\n");

    const span = createdSpans[0];
    expect(span.attrs["tool.output_size_bytes"]).toBe(Buffer.byteLength(emojiOutput, "utf8"));
  });

  it("auto-closes orphan spans after 60s timeout", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    const span = createdSpans[0];
    expect(span.ended).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(span.ended).toBe(true);
    expect(span.status).toEqual({ code: 2, message: "tool_result_missing" });
    expect(span.attrs["tool.paired"]).toBe(false);
    expect(span.attrs["tool.status"]).toBe("orphan");
  });

  it("clears orphan timeout when tool_result arrives before 60s", () => {
    const tracker = new ToolSpanTracker({ "run.id": "r1" }, true);

    tracker.processChunk("stdout", assistantLine([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]) + "\n");

    const span = createdSpans[0];
    expect(span.ended).toBe(false);

    vi.advanceTimersByTime(30_000);
    tracker.processChunk("stdout", userLine([
      { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
    ]) + "\n");

    expect(span.ended).toBe(true);
    expect(span.attrs["tool.paired"]).toBe(true);

    // Fast-forward past the original 60s deadline — span should stay ended.
    vi.advanceTimersByTime(30_000);
    expect(span.ended).toBe(true);
  });
});
