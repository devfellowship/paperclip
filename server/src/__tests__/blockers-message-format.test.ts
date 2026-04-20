import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIssueUrl,
  formatBlockedMessage,
  formatResolvedMessage,
  getPublicUrlBase,
} from "../services/blockers.ts";

describe("blockers — getPublicUrlBase", () => {
  const originalEnv = process.env.PAPERCLIP_PUBLIC_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PAPERCLIP_PUBLIC_URL;
    } else {
      process.env.PAPERCLIP_PUBLIC_URL = originalEnv;
    }
  });

  it("falls back to the canonical public host when env is unset", () => {
    delete process.env.PAPERCLIP_PUBLIC_URL;
    expect(getPublicUrlBase()).toBe("https://ppclip.tainanfidelis.com");
  });

  it("uses an explicitly configured base URL, trimming trailing slashes", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://ppclip.example.com/";
    expect(getPublicUrlBase()).toBe("https://ppclip.example.com");
  });

  it("returns null when the env var is explicitly empty (opt out of URL)", () => {
    process.env.PAPERCLIP_PUBLIC_URL = "";
    expect(getPublicUrlBase()).toBeNull();
  });
});

describe("blockers — buildIssueUrl", () => {
  it("builds URL with company prefix and issue identifier", () => {
    expect(buildIssueUrl("https://ppclip.tainanfidelis.com", "DEV", "DEV-410")).toBe(
      "https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
    );
  });

  it("returns null when base is missing", () => {
    expect(buildIssueUrl(null, "DEV", "DEV-410")).toBeNull();
  });

  it("returns null when prefix is missing", () => {
    expect(buildIssueUrl("https://ppclip.tainanfidelis.com", null, "DEV-410")).toBeNull();
  });

  it("returns null when identifier is missing", () => {
    expect(buildIssueUrl("https://ppclip.tainanfidelis.com", "DEV", null)).toBeNull();
  });

  it("does NOT produce the old broken paperclip.devfellowship.com URL", () => {
    const url = buildIssueUrl("https://ppclip.tainanfidelis.com", "DEV", "DEV-410");
    expect(url).not.toContain("paperclip.devfellowship.com");
  });
});

describe("blockers — formatResolvedMessage", () => {
  it("produces the canonical format with agent name, issue identifier, URL, and summary", () => {
    const text = formatResolvedMessage({
      agentName: "dfl-single-repo-impl",
      issueLabel: "DEV-410",
      issueUrl: "https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
      summary: "Credential guard: missing GITHUB_PAT_WITH_CONTENTS_WRITE",
    });

    expect(text).toBe(
      [
        "\u2705 Resolved: dfl-single-repo-impl unblocked on DEV-410",
        "https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
        "was: Credential guard: missing GITHUB_PAT_WITH_CONTENTS_WRITE",
      ].join("\n"),
    );
  });

  it("preserves the ✅ Resolved prefix so existing consumers still match", () => {
    const text = formatResolvedMessage({
      agentName: "dfl-agent",
      issueLabel: "DEV-1",
      issueUrl: null,
      summary: "foo",
    });
    expect(text.startsWith("\u2705 Resolved:")).toBe(true);
  });

  it("omits the URL line when buildIssueUrl returned null", () => {
    const text = formatResolvedMessage({
      agentName: "dfl-agent",
      issueLabel: "DEV-1",
      issueUrl: null,
      summary: "network flake",
    });
    const lines = text.split("\n");
    expect(lines).toEqual([
      "\u2705 Resolved: dfl-agent unblocked on DEV-1",
      "was: network flake",
    ]);
  });

  it("does not include raw UUIDs in the rendered output", () => {
    const text = formatResolvedMessage({
      agentName: "dfl-single-repo-impl",
      issueLabel: "DEV-410",
      issueUrl: "https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
      summary: "the summary",
    });
    // Regex for any v4-ish UUID
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("blockers — formatBlockedMessage", () => {
  it("formats a new blocker with agent name and DEV identifier", () => {
    const text = formatBlockedMessage({
      agentName: "dfl-single-repo-impl",
      issueLabel: "DEV-410",
      issueTitle: "Wire up GH PAT",
      issueUrl: "https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
      needs: "GITHUB_PAT_WITH_CONTENTS_WRITE env var",
    });

    expect(text).toBe(
      [
        "\u{1F6A7} dfl-single-repo-impl blocked on DEV-410",
        "task: Wire up GH PAT \u00B7 https://ppclip.tainanfidelis.com/DEV/issues/DEV-410",
        "needs: GITHUB_PAT_WITH_CONTENTS_WRITE env var",
      ].join("\n"),
    );
  });

  it("includes the context line when context is provided", () => {
    const text = formatBlockedMessage({
      agentName: "dfl-agent",
      issueLabel: "DEV-1",
      issueTitle: null,
      issueUrl: null,
      needs: "n",
      context: "some context here",
    });
    expect(text).toContain("context: some context here");
  });
});
