import { describe, expect, it } from "vitest";
import { packageToSkillId } from "../src/skill-id.js";

describe("packageToSkillId", () => {
  it("converts a scoped npm package name to a skill id", () => {
    expect(packageToSkillId("@world2agent/sensor-hackernews")).toBe(
      "world2agent-sensor-hackernews",
    );
  });

  it("handles unscoped packages by passing through", () => {
    expect(packageToSkillId("my-sensor")).toBe("my-sensor");
  });

  it("only strips a leading @, not interior @ characters", () => {
    expect(packageToSkillId("@scope/pkg@1.0.0")).toBe("scope-pkg@1.0.0");
  });

  it("replaces all slashes, not just the first", () => {
    expect(packageToSkillId("@scope/pkg/sub")).toBe("scope-pkg-sub");
  });
});
