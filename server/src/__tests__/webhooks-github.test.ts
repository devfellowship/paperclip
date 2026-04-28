import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { webhooksGithubRoutes } from "../routes/webhooks-github.js";

const WEBHOOK_SECRET = "test-secret";

function makeSignature(body: string | Buffer): string {
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

// Mock the DB module
const mockDb = vi.hoisted(() => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    then: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
  };
  // Make the chain return itself for fluent calls
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.insert.mockReturnValue(chain);
  chain.values.mockReturnValue(Promise.resolve());
  chain.update.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  return chain;
});

// Mock heartbeat service
const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function buildIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-uuid-1",
    companyId: "company-uuid-1",
    status: "in_review",
    assigneeAgentId: "agent-uuid-1",
    ...overrides,
  };
}

function buildAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    pausedAt: null,
    status: "idle",
    ...overrides,
  };
}

function makeApp(dbOverride?: Partial<typeof mockDb>) {
  const db = { ...mockDb, ...(dbOverride ?? {}) } as unknown as Parameters<typeof webhooksGithubRoutes>[0];
  const app = express();
  // Capture rawBody like the real app does
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api", webhooksGithubRoutes(db, mockHeartbeat as any));
  app.use(errorHandler);
  return app;
}

const workflowRunPayload = {
  action: "completed",
  workflow_run: {
    id: 999,
    conclusion: "failure",
    event: "pull_request",
    html_url: "https://github.com/owner/repo/actions/runs/999",
    pull_requests: [{ number: 42 }],
  },
  repository: {
    full_name: "owner/repo",
    owner: { login: "owner" },
    name: "repo",
  },
};

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it("returns 401 when signature is missing", async () => {
    const app = makeApp();
    const body = JSON.stringify(workflowRunPayload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    const app = makeApp();
    const body = JSON.stringify(workflowRunPayload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .set("X-Hub-Signature-256", "sha256=badhash")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("returns 204 for non-workflow_run events", async () => {
    const app = makeApp();
    const body = JSON.stringify({ action: "created" });
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "push")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(res.status).toBe(204);
  });

  it("returns 204 for non-failure workflow_run events", async () => {
    const app = makeApp();
    const payload = {
      ...workflowRunPayload,
      workflow_run: { ...workflowRunPayload.workflow_run, conclusion: "success" },
    };
    const body = JSON.stringify(payload);
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(res.status).toBe(204);
  });

  it("returns 204 when no matching issue found", async () => {
    // DB returns no issue
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb([]))),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    const app = makeApp(chain as any);
    const body = JSON.stringify(workflowRunPayload);
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(res.status).toBe(204);
  });

  it("deduplicates: returns 200 with status=deduped when run_id comment exists", async () => {
    let callCount = 0;
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(function(this: unknown) {
        callCount++;
        return this;
      }),
      then: vi.fn().mockImplementation((cb: (v: unknown[]) => unknown) => {
        if (callCount === 1) {
          // First call: issue found
          return Promise.resolve(cb([buildIssueRow()]));
        }
        // Second call: dedup comment found
        return Promise.resolve(cb([{ id: "comment-1" }]));
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    const app = makeApp(chain as any);
    const body = JSON.stringify(workflowRunPayload);
    const sig = makeSignature(body);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deduped");
  });
});

describe("HMAC signature verification", () => {
  it("accepts a correct sha256 signature", async () => {
    // Minimal test: valid sig should pass auth check
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const body = JSON.stringify({ action: "completed", workflow_run: null });
    const sig = makeSignature(body);
    // A missing workflow_run will result in 204, but signature check passed
    const app = makeApp({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb([]))),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    } as any);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "workflow_run")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(res.status).not.toBe(401);
  });
});
