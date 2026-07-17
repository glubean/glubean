import { describe, expect, it } from "vitest";
import { formatProjectionInventory } from "./feedback.js";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("projection feedback", () => {
  it("shows every declaration kind and makes a zero-workflow scan actionable", () => {
    const output = stripAnsi(formatProjectionInventory("Discovered locally", {
      files: 7,
      tests: 18,
      contracts: 6,
      workflows: 0,
      warnings: 1,
    }, { hintWhenNoWorkflows: true }));

    expect(output).toContain("Files          7");
    expect(output).toContain("Tests         18");
    expect(output).toContain("Contracts      6");
    expect(output).toContain("Workflows      0");
    expect(output).toContain("*.workflow.ts");
    expect(output).toContain("workflow()");
  });

  it("does not print the missing-workflow hint when workflows were found", () => {
    const output = stripAnsi(formatProjectionInventory("Discovered locally", {
      tests: 2,
      contracts: 1,
      workflows: 3,
    }, { hintWhenNoWorkflows: true }));

    expect(output).toContain("Workflows      3");
    expect(output).not.toContain("No workflows discovered");
  });
});
