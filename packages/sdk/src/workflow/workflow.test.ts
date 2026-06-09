import { describe, it, expect } from "vitest";
import type { ContractCaseRef } from "../contract-types.js";
import { workflow } from "./builder.js";
import { projectWorkflow } from "./project.js";
import type { Workflow, ActionNode, CheckNode } from "./types.js";

const fakeRef = <I = unknown, O = unknown, AK = never, RO = O>(
  contractId: string,
  caseKey: string,
  target: string,
): ContractCaseRef<I, O, AK, RO> =>
  ({
    __glubean_type: "contract-case-ref",
    contractId,
    caseKey,
    protocol: "http",
    target,
    contract: {} as ContractCaseRef["contract"],
  }) as unknown as ContractCaseRef<I, O, AK, RO>;

describe("workflow() builder", () => {
  it("requires a non-empty string id", () => {
    expect(() => workflow("")).toThrow(/id is required/);
    expect(() => workflow({ id: "" })).toThrow(/id is required/);
    expect(workflow("ok").build().meta.id).toBe("ok");
  });

  it("accumulates nodes in authored order with setup/teardown captured", () => {
    const createUser = fakeRef<unknown, { body: { id: string } }>(
      "user-api",
      "create",
      "POST /users",
    );
    const setupFn = async () => ({ seeded: true });
    const teardownFn = async () => {};

    const wf: Workflow = workflow("signup")
      .meta({ description: "register + verify", tags: ["auth"] })
      .setup(setupFn)
      .call("create user", createUser, {
        in: (s) => s,
        out: (s, res) => ({ ...s, userId: res.body.id }),
      })
      .action("seed token", async (_ctx, s) => ({ ...s, token: "t" }), {
        project: { reads: ["userId"], writes: ["token"], note: "external setup" },
      })
      .check("token belongs to user", async () => {})
      .compute("derive", (s) => s)
      .teardown(teardownFn)
      .build();

    expect(wf.__glubean_type).toBe("workflow");
    expect(wf.meta).toMatchObject({ id: "signup", description: "register + verify", tags: ["auth"] });
    expect(wf.setup).toBe(setupFn);
    expect(wf.teardown).toBe(teardownFn);
    expect(wf.nodes.map((n) => n.kind)).toEqual([
      "contract-call",
      "action",
      "check",
      "compute",
    ]);
    // Every node carries NodeMeta; string shorthand sets id (name defaults to id).
    expect(wf.nodes.map((n) => n.meta.id)).toEqual([
      "create user",
      "seed token",
      "token belongs to user",
      "derive",
    ]);
    expect(wf.nodes.every((n) => n.meta.name === n.meta.id)).toBe(true);
  });

  it("every step accepts a full {...NodeMeta} object (id + name + tags + extensions)", () => {
    const ref = fakeRef<void>("user-api", "create", "POST /users");
    const wf = workflow("w")
      .call(
        { id: "create", name: "Create user", tags: ["write"], extensions: { "x-team": "auth" } },
        ref,
      )
      .action({ id: "seed", name: "Seed buyer" }, async (_c, s) => s)
      .build();

    expect(wf.nodes[0].meta).toMatchObject({
      id: "create",
      name: "Create user",
      tags: ["write"],
      extensions: { "x-team": "auth" },
    });
    expect(wf.nodes[1].meta).toMatchObject({ id: "seed", name: "Seed buyer" });

    const proj = projectWorkflow(wf);
    expect(proj.nodes[0]).toMatchObject({
      id: "create",
      name: "Create user",
      tags: ["write"],
      extensions: { "x-team": "auth" },
      kind: "contract-call",
    });
  });

  it("rejects out-of-order lifecycle (codex P2 runtime guards)", () => {
    const ref = fakeRef<void>("a", "b", "t");
    // setup must come before any step
    expect(() => workflow("w").call("c", ref).setup(async () => ({})))
      .toThrow(/setup\(\) must be called before any step/);
    // teardown must be last — no step may follow it
    expect(() => workflow("w").teardown(async () => {}).call("c", ref))
      .toThrow(/cannot be added after \.teardown\(\)/);
    // …and setup may not follow teardown either
    expect(() => workflow("w").teardown(async () => {}).setup(async () => ({})))
      .toThrow(/setup\(\) must be called before/);
    expect(() => workflow("w").teardown(async () => {}).compute("c", (s) => s))
      .toThrow(/cannot be added after \.teardown\(\)/);
    // async compute is rejected at runtime (JS / `as any` bypass)
    expect(() => workflow("w").compute("c", (async () => ({})) as never))
      .toThrow(/compute\(\) must be synchronous/);
  });

  it(".meta() merges but never overrides the id", () => {
    const wf = workflow("fixed").meta({ id: "hacked", name: "n" } as never).build();
    expect(wf.meta.id).toBe("fixed");
    expect(wf.meta.name).toBe("n");
  });
});

describe("projectWorkflow() static grades", () => {
  it("grades each node kind at its static floor + rolls up the summary", () => {
    const ref = fakeRef("user-api", "create", "POST /users");
    const wf = workflow("grades")
      .call("call", ref, { in: (s) => s, out: (s) => s })
      .compute("pure", (s) => s)
      .action("hinted action", async (_c, s) => s, {
        project: { writes: ["x"], note: "n" },
      })
      .action("bare action", async (_c, s) => s)
      .check("hinted check", async () => {}, { project: { asserts: "x == y" } })
      .check("bare check", async () => {})
      .build();

    const proj = projectWorkflow(wf);

    expect(proj.id).toBe("grades");
    const byName = Object.fromEntries(proj.nodes.map((n) => [n.name, n.grade]));
    expect(byName).toEqual({
      call: "full",
      pure: "full",
      "hinted action": "partial",
      "bare action": "opaque",
      "hinted check": "partial",
      "bare check": "opaque",
    });
    expect(proj.gradeSummary).toEqual({ full: 2, partial: 2, opaque: 2 });
  });

  it("contract-call projection carries target + identity + protocol + accept", () => {
    const ref = fakeRef<void, { ok: true }, number, { status: number; body: unknown }>(
      "user-api",
      "create",
      "POST /users",
    );
    const proj = projectWorkflow(
      workflow("w").call("c", ref, { accept: [200, 201] }).build(),
    );
    expect(proj.nodes[0]).toMatchObject({
      kind: "contract-call",
      id: "c",
      target: "POST /users",
      protocol: "http",
      contractId: "user-api",
      caseKey: "create",
      accept: [200, 201],
      grade: "full",
    });
  });

  it("action grade reflects presence of any hint; check grade needs asserts", () => {
    const onlyReads = workflow("w")
      .action("a", async (_c, s) => s, { project: { reads: ["x"] } })
      .check("c", async () => {}, { project: { reads: ["x"] } }) // reads but no asserts
      .build();
    const proj = projectWorkflow(onlyReads);
    expect((proj.nodes[0]).grade).toBe("partial"); // action: reads hint counts
    expect((proj.nodes[1]).grade).toBe("opaque"); // check: reads alone is not asserts
  });
});

// Compile-time guards (codex slice-1 P2). Wrapped in a never-called function so
// the TYPES are checked at build but nothing executes at import (some of these
// now trip runtime guards too — e.g. async compute throws).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _compileTimeGuards(): void {
  // project hints typecheck against node types.
  const _typecheck: ActionNode["project"] = { reads: ["a"], writes: ["b"], note: "n" };
  const _typecheck2: CheckNode["project"] = { asserts: "x" };
  void _typecheck;
  void _typecheck2;

  // A case that REQUIRES input must not compile without an `in` binding.
  const _inputRef = fakeRef<{ email: string }, unknown>("user-api", "create", "POST /users");
  // @ts-expect-error — `in` is required because the case needs input
  workflow("guard").call("create", _inputRef);
  // Providing `in` (typed to the case input) compiles:
  workflow("guard").call("create", _inputRef, { in: () => ({ email: "a@b.c" }) });

  // `out`'s `res` is the typed primary outcome WITHOUT `accept`, and widens to
  // the raw outcome WITH `accept`.
  const _acceptRef = fakeRef<void, { ok: true }, number, { status: number; body: unknown }>(
    "a",
    "b",
    "t",
  );
  workflow("guard").call("c", _acceptRef, {
    out: (s, res) => {
      const _primary: { ok: true } = res; // res === CaseOutput (no accept)
      void _primary;
      return s;
    },
  });
  workflow("guard").call("c", _acceptRef, {
    accept: [200, 201],
    out: (s, res) => {
      const _raw: { status: number } = res; // res widened to RawOutcome
      void _raw;
      return s;
    },
  });

  // A void-returning action PRESERVES state.
  workflow("guard")
    .setup(async () => ({ x: 1 }))
    .action("seed", async () => {}) // void → state type must stay { x: 1 }
    .compute("derive", (s) => {
      const _carried: { x: number } = s; // s is still { x: 1 }, not void
      void _carried;
      return s;
    });
  // (async compute is rejected at RUNTIME — covered by the lifecycle-guard test.)

  // .poll(): a case that REQUIRES input must not compile without `in`; the L2
  // `until` and `out` lenses see the typed response.
  const _pollRef = fakeRef<{ jobId: string }, { status: string }>("job", "get", "GET /job");
  // @ts-expect-error — `in` is required because the case needs input
  workflow("guard").poll("wait", _pollRef, {
    until: (w) => w.when((r) => r.status).eq("done"),
    timeout: 1000,
  });
  workflow("guard")
    .setup(async () => ({ jobId: "j1" }))
    .poll("wait", _pollRef, {
      in: (s) => ({ jobId: s.jobId }),
      until: (w) => w.when((r) => r.status).eq("done"), // r is the typed response
      out: (s, res) => {
        const _typed: { status: string } = res; // res === CaseOutput (no accept)
        void _typed;
        return s;
      },
      timeout: 1000,
    });
  // untilRuntime without a message must not compile.
  workflow("guard")
    .setup(async () => ({ jobId: "j1" }))
    // @ts-expect-error — `message` is required with untilRuntime
    .poll("wait", _pollRef, {
      in: (s) => ({ jobId: s.jobId }),
      untilRuntime: (_c, res: { status: string }) => res.status === "done",
      timeout: 1000,
    });
}
void _compileTimeGuards;
