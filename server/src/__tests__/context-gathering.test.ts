/**
 * Unit tests for the DEV-247 pre-task context packet writer.
 *
 * We stub the drizzle `db` with a tiny chainable object that returns
 * canned rows for each table. This keeps the tests fast and does not
 * require spinning up embedded-postgres — we are asserting filesystem
 * output + HTTP mocking behavior, not SQL semantics.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { gatherContextPacket, CONTEXT_PACKET_FILENAME } from "../services/context-gathering.js";

interface CannedRows {
  issues?: Record<string, unknown>[];
  children?: Record<string, unknown>[];
  recentRuns?: Record<string, unknown>[];
}

/**
 * Build a fake Db that answers the three chained selects the module emits.
 * Order of calls: loadIssue, loadParent?, loadChildren, loadRecentRuns.
 * We pattern-match on what the chain is fed via a FIFO of canned result sets.
 */
function buildFakeDb(initialQueue: Array<unknown[] | ((call: number) => unknown[])>): Db {
  let i = 0;
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    chain.from = ret;
    chain.where = ret;
    chain.orderBy = ret;
    chain.limit = ret;
    // thenable: resolves to the next queued result set
    chain.then = (resolve: (rows: unknown[]) => void) => {
      const entry = initialQueue[i++] ?? [];
      const rows = typeof entry === "function" ? entry(i) : entry;
      resolve(rows);
      return Promise.resolve(rows);
    };
    return chain;
  };
  const db = {
    select: () => makeChain(),
  } as unknown as Db;
  return db;
}

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ctx-test-"));
}

async function cleanupDir(dir: string | null) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function readPacket(workspace: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(workspace, CONTEXT_PACKET_FILENAME), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("gatherContextPacket", () => {
  let workspaceDir: string | null = null;

  beforeEach(async () => {
    workspaceDir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(workspaceDir);
    workspaceDir = null;
  });

  it("writes a packet with empty sections when the issue row is missing (no throw)", async () => {
    // Queue: loadIssue -> [], loadChildren -> [], recentRuns issueScoped -> [], recentRuns agentScoped -> []
    const db = buildFakeDb([[], [], [], []]);
    const result = await gatherContextPacket({
      issue: { id: "issue-1", companyId: "co-1" },
      agent: { id: "agent-1", name: "t-agent", companyId: "co-1" },
      workspaceCwd: workspaceDir!,
      db,
    });
    expect(result).not.toBeNull();
    expect(result!.bytesWritten).toBeGreaterThan(0);

    const packet = await readPacket(workspaceDir!);
    expect(packet.schemaVersion).toBe(1);
    expect(packet.issue).toEqual({
      id: "issue-1",
      title: null,
      description: null,
      status: null,
      priority: null,
    });
    expect(packet.parent).toBeNull();
    expect(packet.children).toEqual([]);
    expect(packet.recentRuns).toEqual([]);
    expect(packet.fleetHealth).toBeNull();
    expect(typeof packet.generatedAt).toBe("string");
  });

  it("includes parent.identifier when the issue has a parent", async () => {
    const issueRow = {
      id: "child-issue",
      identifier: "DEV-999",
      title: "Child task",
      description: "desc",
      status: "in_progress",
      priority: "medium",
      parentId: "parent-issue",
      githubRepo: null,
      githubPrNumber: null,
    };
    const parentRow = {
      id: "parent-issue",
      identifier: "DEV-163",
      title: "Parent epic",
      description: null,
      status: "in_progress",
      priority: "high",
      parentId: null,
      githubRepo: null,
      githubPrNumber: null,
    };
    // Queue: loadIssue -> [issueRow], loadParent -> [parentRow], loadChildren -> [], issueScoped -> [], agentScoped -> []
    const db = buildFakeDb([[issueRow], [parentRow], [], [], []]);

    await gatherContextPacket({
      issue: { id: "child-issue", companyId: "co-1" },
      agent: { id: "agent-1", name: "t-agent", companyId: "co-1" },
      workspaceCwd: workspaceDir!,
      db,
    });

    const packet = await readPacket(workspaceDir!);
    expect(packet.parent).toEqual({
      id: "parent-issue",
      identifier: "DEV-163",
      title: "Parent epic",
    });
    expect(packet.issue).toEqual({
      id: "child-issue",
      title: "Child task",
      description: "desc",
      status: "in_progress",
      priority: "medium",
    });
  });

  it("populates fleetHealth when the issue has a githubRepo (HTTP mocked)", async () => {
    const issueRow = {
      id: "issue-2",
      identifier: "DEV-247",
      title: "CI work",
      description: "fix ci",
      status: "todo",
      priority: "high",
      parentId: null,
      githubRepo: "dfl-reviews",
      githubPrNumber: 50,
    };
    // Queue: loadIssue -> [issueRow], loadChildren -> [], issueScoped -> [], agentScoped -> []
    const db = buildFakeDb([[issueRow], [], [], []]);

    let fetchedUrl: string | null = null;
    const result = await gatherContextPacket({
      issue: { id: "issue-2", companyId: "co-1" },
      agent: { id: "agent-1", name: "t-agent", companyId: "co-1" },
      workspaceCwd: workspaceDir!,
      db,
      fleetHealthFetch: async (url) => {
        fetchedUrl = url;
        return {
          repos: [
            {
              fullName: "devfellowship/dfl-reviews",
              name: "dfl-reviews",
              ciStatus: "passing",
              openPRBranches: [
                { number: 50, title: "feat: context packet", ciStatus: "passing" },
                { number: 51, title: "chore: deps", ciStatus: "failing" },
              ],
            },
          ],
        };
      },
    });

    expect(result).not.toBeNull();
    expect(fetchedUrl).toBe("https://fleet-health.devfellowship.com/api/fleet");

    const packet = await readPacket(workspaceDir!);
    const fh = packet.fleetHealth as Record<string, unknown>;
    expect(fh).not.toBeNull();
    expect(fh.repo).toBe("dfl-reviews");
    expect(fh.ciStatus).toBe("passing");
    expect(fh.openPRBranches).toEqual([
      { number: 50, title: "feat: context packet", ciStatus: "passing" },
      { number: 51, title: "chore: deps", ciStatus: "failing" },
    ]);
  });

  it("returns null (no throw) when workspaceCwd does not exist", async () => {
    const db = buildFakeDb([]);
    const result = await gatherContextPacket({
      issue: { id: "issue-x", companyId: "co-1" },
      agent: { id: "agent-1", name: "t-agent", companyId: "co-1" },
      workspaceCwd: "/nonexistent/paperclip-context-test-path-xyz-404",
      db,
    });
    expect(result).toBeNull();
  });
});
