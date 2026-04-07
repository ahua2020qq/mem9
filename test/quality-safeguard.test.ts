import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  capCompactionSummary,
  capCompactionSummaryPreservingSuffix,
  formatPreservedTurnsSection,
  formatToolFailuresSection,
  extractLatestUserAsk,
  REQUIRED_SUMMARY_SECTIONS,
} from "../src/quality-safeguard.js";

const GOOD_SUMMARY = [
  "## Decisions",
  "Used React for frontend.",
  "",
  "## Open TODOs",
  "Add tests.",
  "",
  "## Constraints/Rules",
  "Must use TypeScript.",
  "",
  "## Pending user asks",
  "Implement dark mode.",
  "",
  "## Exact identifiers",
  "project-id-abc123",
].join("\n");

describe("quality-safeguard", () => {
  describe("REQUIRED_SUMMARY_SECTIONS", () => {
    it("has 5 required sections", () => {
      assert.equal(REQUIRED_SUMMARY_SECTIONS.length, 5);
    });

    it("includes all expected headings", () => {
      const expected = ["Decisions", "TODOs", "Constraints", "Pending", "Exact identifiers"];
      for (const keyword of expected) {
        assert.ok(
          REQUIRED_SUMMARY_SECTIONS.some((s) => s.includes(keyword)),
          `Missing section with "${keyword}"`,
        );
      }
    });
  });

  describe("extractOpaqueIdentifiers", () => {
    it("extracts URLs", () => {
      const ids = extractOpaqueIdentifiers("Visit https://example.com/api for docs");
      assert.ok(ids.some((id) => id.includes("example.com")));
    });

    it("extracts hex identifiers", () => {
      const ids = extractOpaqueIdentifiers("Commit abcdef1234567890");
      assert.ok(ids.some((id) => id.includes("ABCDEF")));
    });

    it("extracts file paths", () => {
      const ids = extractOpaqueIdentifiers("Edit /src/components/App.tsx");
      assert.ok(ids.some((id) => id.includes("App.tsx")));
    });

    it("limits to MAX_EXTRACTED_IDENTIFIERS", () => {
      const hexIds = Array.from({ length: 20 }, (_, i) => `hex${i.toString(16).padStart(12, "0")}`).join(" ");
      const ids = extractOpaqueIdentifiers(hexIds);
      assert.ok(ids.length <= 12);
    });

    it("deduplicates identifiers", () => {
      const ids = extractOpaqueIdentifiers("See abcdef1234567890 and abcdef1234567890 again");
      const hexIds = ids.filter((id) => id.includes("ABCDEF"));
      assert.equal(hexIds.length, 1);
    });
  });

  describe("auditSummaryQuality", () => {
    it("passes for good summary", () => {
      const result = auditSummaryQuality({
        summary: GOOD_SUMMARY,
        identifiers: ["project-id-abc123"],
        latestAsk: "Implement dark mode.",
      });
      assert.ok(result.ok);
      assert.equal(result.reasons.length, 0);
    });

    it("fails when section is missing", () => {
      const badSummary = GOOD_SUMMARY.replace("## Decisions\n", "");
      const result = auditSummaryQuality({
        summary: badSummary,
        identifiers: [],
        latestAsk: null,
      });
      assert.ok(!result.ok);
      assert.ok(result.reasons.some((r) => r.includes("missing_section")));
    });

    it("fails when identifier is missing in strict mode", () => {
      const result = auditSummaryQuality({
        summary: GOOD_SUMMARY,
        identifiers: ["missing-uuid-abc"],
        latestAsk: null,
        identifierPolicy: "strict",
      });
      assert.ok(!result.ok);
      assert.ok(result.reasons.some((r) => r.includes("missing_identifiers")));
    });

    it("skips identifier check when policy is off", () => {
      const result = auditSummaryQuality({
        summary: GOOD_SUMMARY,
        identifiers: ["missing-uuid-abc"],
        latestAsk: null,
        identifierPolicy: "off",
      });
      // Should not have missing_identifiers reason
      assert.ok(!result.reasons.some((r) => r.includes("missing_identifiers")));
    });

    it("fails when latest ask is not reflected", () => {
      const result = auditSummaryQuality({
        summary: GOOD_SUMMARY,
        identifiers: [],
        latestAsk: "completely unique ask about quantum computing",
      });
      assert.ok(!result.ok);
      assert.ok(result.reasons.some((r) => r.includes("latest_user_ask")));
    });

    it("passes when latest ask is null", () => {
      const result = auditSummaryQuality({
        summary: GOOD_SUMMARY,
        identifiers: [],
        latestAsk: null,
      });
      assert.ok(result.ok);
    });
  });

  describe("buildCompactionStructureInstructions", () => {
    it("includes all required sections", () => {
      const instructions = buildCompactionStructureInstructions();
      for (const section of REQUIRED_SUMMARY_SECTIONS) {
        assert.ok(instructions.includes(section), `Missing ${section}`);
      }
    });

    it("appends custom instructions", () => {
      const instructions = buildCompactionStructureInstructions("Keep it short");
      assert.ok(instructions.includes("Keep it short"));
    });
  });

  describe("buildStructuredFallbackSummary", () => {
    it("returns structured template when no previous summary", () => {
      const summary = buildStructuredFallbackSummary();
      for (const section of REQUIRED_SUMMARY_SECTIONS) {
        assert.ok(summary.includes(section));
      }
    });

    it("preserves previous summary if it has all sections", () => {
      const result = buildStructuredFallbackSummary(GOOD_SUMMARY);
      assert.equal(result, GOOD_SUMMARY);
    });
  });

  describe("capCompactionSummary", () => {
    it("does not truncate short summaries", () => {
      const short = "Short summary";
      assert.equal(capCompactionSummary(short, 1000), short);
    });

    it("truncates and adds marker for long summaries", () => {
      const long = "x".repeat(200);
      const capped = capCompactionSummary(long, 100);
      assert.ok(capped.length <= 200);
      assert.ok(capped.includes("truncated"));
    });
  });

  describe("capCompactionSummaryPreservingSuffix", () => {
    it("preserves suffix intact", () => {
      const body = "x".repeat(200);
      const suffix = "\n\n## Suffix\nImportant data";
      const capped = capCompactionSummaryPreservingSuffix(body, suffix, 100);
      assert.ok(capped.endsWith("Important data"));
    });
  });

  describe("formatPreservedTurnsSection", () => {
    it("returns empty string for no messages", () => {
      assert.equal(formatPreservedTurnsSection([]), "");
    });

    it("formats user and assistant turns", () => {
      const msgs = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const result = formatPreservedTurnsSection(msgs);
      assert.ok(result.includes("User: Hello"));
      assert.ok(result.includes("Assistant: Hi there"));
      assert.ok(result.includes("Recent turns"));
    });

    it("truncates long turns", () => {
      const msgs = [{ role: "user", content: "x".repeat(1000) }];
      const result = formatPreservedTurnsSection(msgs);
      assert.ok(result.includes("..."));
    });
  });

  describe("formatToolFailuresSection", () => {
    it("returns empty string for no failures", () => {
      assert.equal(formatToolFailuresSection([]), "");
    });

    it("formats tool failures", () => {
      const failures = [{ toolName: "bash", summary: "command failed" }];
      const result = formatToolFailuresSection(failures);
      assert.ok(result.includes("bash"));
      assert.ok(result.includes("command failed"));
    });
  });

  describe("extractLatestUserAsk", () => {
    it("extracts latest user message from end", () => {
      const msgs = [
        { role: "user", content: "First ask" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Latest ask" },
      ];
      assert.equal(extractLatestUserAsk(msgs), "Latest ask");
    });

    it("returns null when no user messages", () => {
      const msgs = [{ role: "assistant", content: "Reply" }];
      assert.equal(extractLatestUserAsk(msgs), null);
    });

    it("returns null for empty array", () => {
      assert.equal(extractLatestUserAsk([]), null);
    });
  });
});
