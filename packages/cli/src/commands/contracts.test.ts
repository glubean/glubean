import { test, expect, describe } from "vitest";
import {
  formatMdOutline,
  formatJson,
  formatFlowsMdSection,
  flowToJson,
  lintDescription,
} from "./contracts.js";
import type { ContractStaticMeta } from "@glubean/scanner/static";
import type { NormalizedFlowMeta } from "@glubean/scanner";

// ── Fixtures ────────────────────────────────────────────────────────────────

const userRegistration: ContractStaticMeta = {
  contractId: "create-user",
  exportName: "createUser",
  line: 3,
  endpoint: "POST /users",
  protocol: "http",
  description: "新用户注册账号",
  feature: "用户注册",
  cases: [
    { key: "success", line: 10, description: "邮箱和密码注册成功，返回完整用户信息", expectStatus: 201 },
    { key: "duplicateEmail", line: 15, description: "已注册的邮箱再次注册时被拒绝", expectStatus: 409 },
    { key: "noAuth", line: 20, description: "未登录状态下无法执行此操作", expectStatus: 401 },
  ],
};

const getUserById: ContractStaticMeta = {
  contractId: "get-user",
  exportName: "getUser",
  line: 25,
  endpoint: "GET /users/:id",
  protocol: "http",
  description: "查询用户信息",
  feature: "用户注册",
  cases: [
    { key: "found", line: 30, description: "根据 ID 查询已有用户，返回完整资料", expectStatus: 200 },
    { key: "deleted", line: 35, description: "软删除用户返回 410", deferred: "后端未实现" },
  ],
};

const googleAuth: ContractStaticMeta = {
  contractId: "google-callback",
  exportName: "googleCallback",
  line: 40,
  endpoint: "POST /auth/google/callback",
  protocol: "http",
  description: "Google 令牌换取应用凭证",
  feature: "Google 登录",
  cases: [
    { key: "success", line: 45, description: "有效的 Google 凭证换取应用访问令牌", expectStatus: 200 },
    { key: "invalidToken", line: 50, description: "伪造或过期的凭证被拒绝", expectStatus: 401 },
    { key: "realOAuth", line: 55, description: "完整 Google OAuth 流程", requires: "browser" },
    { key: "expensive", line: 60, description: "高成本操作", defaultRun: "opt-in", expectStatus: 200 },
  ],
};

const noFeature: ContractStaticMeta = {
  contractId: "health-check",
  exportName: "healthCheck",
  line: 70,
  endpoint: "GET /health",
  protocol: "http",
  cases: [
    { key: "ok", line: 75, description: "健康检查通过", expectStatus: 200 },
  ],
};

const allContracts = [userRegistration, getUserById, googleAuth, noFeature];

// ── md-outline ──────────────────────────────────────────────────────────────

describe("formatMdOutline", () => {
  test("groups by feature", () => {
    const output = formatMdOutline(allContracts);
    // Two contracts share "用户注册"
    expect(output).toContain("## 用户注册");
    expect(output).toContain("## Google 登录");
    // No feature → grouped by endpoint
    expect(output).toContain("## GET /health");
  });

  test("includes case key and description", () => {
    const output = formatMdOutline([userRegistration]);
    expect(output).toContain("**success** — 邮箱和密码注册成功，返回完整用户信息");
    expect(output).toContain("**duplicateEmail** — 已注册的邮箱再次注册时被拒绝");
  });

  test("marks deferred cases with ⊘", () => {
    const output = formatMdOutline([getUserById]);
    expect(output).toContain("⊘ **deleted** — deferred: 后端未实现");
  });

  test("marks requires cases with ⊘", () => {
    const output = formatMdOutline([googleAuth]);
    expect(output).toContain("⊘ **realOAuth** — requires: browser");
  });

  test("marks opt-in cases", () => {
    const output = formatMdOutline([googleAuth]);
    expect(output).toContain("**expensive** — 高成本操作 *(opt-in)*");
  });

  test("does not contain status codes", () => {
    const output = formatMdOutline(allContracts);
    expect(output).not.toMatch(/\b(200|201|401|409|410)\b/);
  });

  test("does not contain HTTP methods", () => {
    const output = formatMdOutline(allContracts);
    // Endpoint may appear as sub-heading under feature, but not as prefix on cases
    const caseLines = output.split("\n").filter((l) => l.startsWith("- "));
    for (const line of caseLines) {
      expect(line).not.toMatch(/\bPOST\b|\bGET\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);
    }
  });

  test("includes summary line", () => {
    const output = formatMdOutline(allContracts);
    expect(output).toContain("10 cases");
    expect(output).toContain("active");
    expect(output).toContain("deferred");
  });

  test("uses contract-level description as intro line", () => {
    const output = formatMdOutline([userRegistration]);
    expect(output).toContain("新用户注册账号");
  });

  test("falls back to endpoint when no contract-level description", () => {
    const output = formatMdOutline([noFeature]);
    // noFeature has no description and feature=endpoint, so no intro line
    expect(output).not.toContain("GET /health\n\nGET /health");
  });

  test("shows endpoint when feature differs from endpoint and no description", () => {
    const noDesc: ContractStaticMeta = {
      ...userRegistration,
      description: undefined,
    };
    const output = formatMdOutline([noDesc]);
    // Falls back to endpoint since feature != endpoint
    expect(output).toContain("POST /users");
  });

  test("surfaces given preconditions in case notes", () => {
    const output = formatMdOutline([
      {
        ...userRegistration,
        cases: [
          {
            key: "duplicateEmail",
            line: 15,
            description: "Duplicate email is rejected.",
            expectStatus: 409,
            given: "a user with this email already exists",
          },
        ],
      },
    ]);
    expect(output).toContain(
      "**duplicateEmail** — Duplicate email is rejected. *(given: a user with this email already exists)*",
    );
  });
});

// ── json ────────────────────────────────────────────────────────────────────

describe("formatJson", () => {
  test("outputs valid JSON with features array", () => {
    const output = formatJson(allContracts);
    const parsed = JSON.parse(output);
    expect(parsed.features).toBeInstanceOf(Array);
    expect(parsed.features).toHaveLength(3); // 用户注册, Google 登录, GET /health
  });

  test("includes summary", () => {
    const parsed = JSON.parse(formatJson(allContracts));
    expect(parsed.summary.total).toBe(10);
    expect(parsed.summary.deferred).toBe(1);
    expect(parsed.summary.gated).toBe(1);
  });

  test("includes case description", () => {
    const parsed = JSON.parse(formatJson([userRegistration]));
    expect(parsed.features[0].contracts[0].cases[0].description).toBe(
      "邮箱和密码注册成功，返回完整用户信息",
    );
  });

  test("includes feature name and description on contract", () => {
    const parsed = JSON.parse(formatJson([userRegistration]));
    expect(parsed.features[0].name).toBe("用户注册");
    expect(parsed.features[0].contracts[0].feature).toBe("用户注册");
    expect(parsed.features[0].contracts[0].description).toBe("新用户注册账号");
  });

  test("includes given preconditions on cases", () => {
    const parsed = JSON.parse(
      formatJson([
        {
          ...userRegistration,
          cases: [
            {
              key: "duplicateEmail",
              line: 15,
              description: "Duplicate email is rejected.",
              expectStatus: 409,
              given: "a user with this email already exists",
            },
          ],
        },
      ]),
    );
    expect(parsed.features[0].contracts[0].cases[0].given).toBe(
      "a user with this email already exists",
    );
  });
});

// ── description lint ────────────────────────────────────────────────────────

describe("lintDescription", () => {
  test("warns when description starts with HTTP method", () => {
    const w = lintDescription("c", "k", "POST request creates user");
    expect(w).toBeDefined();
    expect(w!.message).toContain("HTTP method");
  });

  test("warns when description contains status code", () => {
    const w = lintDescription("c", "k", "Valid input returns 201");
    expect(w).toBeDefined();
    expect(w!.message).toContain("status code");
  });

  test("warns on 'status code' text", () => {
    const w = lintDescription("c", "k", "Checks status code is correct");
    expect(w).toBeDefined();
  });

  test("warns on technical jargon", () => {
    const w = lintDescription("c", "k", "Validates request body structure");
    expect(w).toBeDefined();
    expect(w!.message).toContain("technical jargon");
  });

  test("passes good business description", () => {
    expect(lintDescription("c", "k", "邮箱和密码注册成功，返回完整用户信息")).toBeUndefined();
    expect(lintDescription("c", "k", "Duplicate email is rejected")).toBeUndefined();
    expect(lintDescription("c", "k", "Unauthenticated access is blocked")).toBeUndefined();
  });
});

// ── Flow rendering ──────────────────────────────────────────────────────────

const sampleFlow: NormalizedFlowMeta = {
  id: "signup-flow",
  exportName: "signupFlow",
  protocol: "flow",
  description: "End-to-end signup path",
  tags: ["e2e"],
  setupDynamic: true,
  steps: [
    {
      kind: "contract-call",
      name: "register",
      contractId: "create-user",
      caseKey: "ok",
      protocol: "http",
      target: "POST /users",
      inputs: [
        { target: "body.email", source: { kind: "path", path: "state.email" } },
      ],
      outputs: [
        { target: "state.userId", source: { kind: "path", path: "response.body.id" } },
      ],
    },
    {
      kind: "compute",
      name: "derive",
      reads: ["state.userId"],
      writes: ["trackingId"],
    },
    {
      kind: "contract-call",
      contractId: "get-user",
      caseKey: "ok",
      protocol: "http",
      target: "GET /users/:id",
      inputs: [
        { target: "params.id", source: { kind: "path", path: "state.userId" } },
      ],
    },
  ],
};

describe("formatFlowsMdSection", () => {
  test("renders flow with contract-call + compute steps and field mappings", () => {
    const md = formatFlowsMdSection([sampleFlow]);
    expect(md).toContain("## Flows");
    expect(md).toContain("### signup-flow");
    expect(md).toContain("e2e");
    expect(md).toContain("End-to-end signup path");
    expect(md).toContain("setup: *<dynamic>*");
    // Contract-call step 1
    expect(md).toContain("1. **create-user#ok**");
    expect(md).toContain("body.email ← state.email");
    expect(md).toContain("state.userId ← response.body.id");
    // Compute step 2
    expect(md).toContain("2. **<compute>** — derive");
    expect(md).toContain("reads: state.userId");
    expect(md).toContain("writes: trackingId");
    // Contract-call step 3
    expect(md).toContain("3. **get-user#ok**");
    expect(md).toContain("params.id ← state.userId");
  });

  test("returns empty string for empty flows", () => {
    expect(formatFlowsMdSection([])).toBe("");
  });
});

describe("flowToJson", () => {
  test("emits JSON-safe object mirroring extracted projection", () => {
    const obj = flowToJson(sampleFlow);
    expect(obj.id).toBe("signup-flow");
    expect(obj.tags).toEqual(["e2e"]);
    expect(obj.setupDynamic).toBe(true);
    expect(Array.isArray(obj.steps)).toBe(true);
    const steps = obj.steps as any[];
    expect(steps[0].kind).toBe("contract-call");
    expect(steps[0].contractId).toBe("create-user");
    expect(steps[1].kind).toBe("compute");
    expect(steps[1].reads).toEqual(["state.userId"]);
    // JSON-safe round-trip
    const cloned = JSON.parse(JSON.stringify(obj));
    expect(cloned).toEqual(obj);
  });
});

describe("formatJson with flows", () => {
  test("includes flows[] when provided", () => {
    const out = formatJson([], [sampleFlow]);
    const parsed = JSON.parse(out);
    expect(parsed.flows).toBeDefined();
    expect(parsed.flows.length).toBe(1);
    expect(parsed.flows[0].id).toBe("signup-flow");
  });

  test("omits flows key when empty", () => {
    const out = formatJson([], []);
    const parsed = JSON.parse(out);
    expect(parsed.flows).toBeUndefined();
  });
});
