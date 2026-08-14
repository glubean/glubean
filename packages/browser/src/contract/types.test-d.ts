/**
 * Type-level tests for browser contract case factories.
 *
 * These are compile-only checks. They prove the curried
 * `browserCase(schema)(case)` locks the logical input shape across `needs`,
 * `steps[].action`, and `verify` with NOTHING defaulted: `N` is inferred from
 * the schema VALUE (first call) and `C` from the case literal (second call).
 *
 * Browser journeys have no per-case response schema (no `expect.schema`, no
 * `__caseOutputShape` marker — see `BrowserFlowCaseOutput`), so the
 * "preserved type" axis here is `PageType` instead: the capability surface of
 * `steps[].action`'s `page`, which must survive both inference routes.
 */

import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { browserCase, defineBrowserCase } from "../index.js";
import type {
  BrowserCaseBody,
  BrowserContractCase,
  BrowserPageClient,
  InstrumentedPage,
} from "../index.js";
import type { ExtensionPage } from "../chrome-extension/index.js";

function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

declare const client: BrowserPageClient<InstrumentedPage>;
declare const chrome: BrowserPageClient<ExtensionPage>;

const app = contract.browser.with("app", { client });
const ext = contract.browser.with("ext", { client: chrome });

{
  // ---------------------------------------------------------------------
  // 1. Positive contextual typing: the action / verify input IS the schema's
  // output type — inferred, never annotated.
  // ---------------------------------------------------------------------
  const typedInput = browserCase(s<{ email: string; password: string }>())({
    description: "a returning user signs in",
    entry: "/login",
    steps: [
      {
        id: "submit",
        intent: "fill the credentials and submit",
        action: async (page, input) => {
          // Proves `input` is `{email, password}` and NOT implicitly `any`
          // (which would make the drift assertions below vacuous).
          const email: string = input.email;
          void email;
          void input.password;
          // ...and that the default page keeps its instrumented surface.
          void page.url();
        },
      },
    ],
    expect: [{ id: "lands-on-dashboard", url: { path: "/dashboard" } }],
    verify: (_ctx, evidence, input) => {
      const email: string = input.email;
      void email;
      void evidence.finalUrl;
    },
  });
  void typedInput;

  // ---------------------------------------------------------------------
  // 2. Drift guard: a key that is not on the schema is a compile error in
  // both function-valued positions.
  // ---------------------------------------------------------------------
  const _driftAction = browserCase(s<{ email: string }>())({
    description: "action drift",
    steps: [
      {
        id: "s1",
        intent: "i",
        // @ts-expect-error -- `wrongKey` is not on Needs `{email: string}`.
        action: async (_page, { wrongKey }) => {
          void wrongKey;
        },
      },
    ],
  });
  void _driftAction;

  const _driftVerify = browserCase(s<{ email: string }>())({
    description: "verify drift",
    steps: [],
    // @ts-expect-error -- `wrongKey` is not on Needs `{email: string}`.
    verify: (_ctx, _evidence, { wrongKey }) => {
      void wrongKey;
    },
  });
  void _driftVerify;

  // ---------------------------------------------------------------------
  // 3. PageType preserved — route A: the ENCLOSING contract's client fixes it,
  // and it is pinned before the `action` bodies are checked.
  // ---------------------------------------------------------------------
  const _extInline = ext("extension.sidepanel", {
    cases: {
      openPanel: browserCase(s<{ email: string }>())({
        description: "the toolbar action opens the side panel",
        steps: [
          {
            id: "open",
            intent: "open the native side panel",
            action: async (page, input) => {
              void input.email;
              // Only compiles when PageType inferred as ExtensionPage.
              const handle = await page.extension.sidePanel.open();
              await handle.close();
            },
          },
        ],
      }),
    },
  });
  void _extInline;

  // Route B: the case's OWN `client` fixes it, with no enclosing contract.
  const _extStandalone = browserCase(s<{ email: string }>())({
    description: "standalone case pinned by its own client",
    client: chrome,
    steps: [
      {
        id: "open",
        intent: "open the native side panel",
        action: async (page, input) => {
          void input.email;
          const handle = await page.extension.sidePanel.open();
          await handle.close();
        },
      },
    ],
  });
  void _extStandalone;

  // Neither route: PageType falls back to InstrumentedPage. This is the one
  // shape `defineBrowserCase<Input, PageType>` still expresses and
  // `browserCase` does not — see the factories' JSDoc.
  const _defaultPage = browserCase(s<{ email: string }>())({
    description: "standalone, client-less",
    steps: [
      {
        id: "s1",
        intent: "i",
        action: async (page, input) => {
          void input.email;
          // @ts-expect-error -- no page-type route: `extension` is not on
          // InstrumentedPage.
          void page.extension;
        },
      },
    ],
  });
  void _defaultPage;

  // A default-page case is still USABLE in an extension contract — an action
  // that accepts the wider page accepts the narrower one (contravariance).
  const _defaultInExt = ext("extension.reuse", {
    cases: { ok: _defaultPage },
  });
  void _defaultInExt;

  // ---------------------------------------------------------------------
  // 4. Single declaration site: `needs` belongs to the factory call, never
  // to the case literal (runtime throws on it too).
  // ---------------------------------------------------------------------
  const _doubleDeclared = browserCase(s<{ email: string }>())({
    description: "declares needs twice",
    // @ts-expect-error -- `needs` is owned by the factory; BrowserCaseBody pins
    // the field to `never` so writing it here cannot compile.
    needs: s<{ email: string }>(),
    steps: [],
  });
  void _doubleDeclared;

  // ...but an explicit `needs: undefined` DECLARES NOTHING and compiles:
  // `exactOptionalPropertyTypes` is off, so `needs?: never` admits undefined.
  // The runtime tolerates it for exactly this reason (see browser-case.test.ts)
  // — the two layers must promise the same thing.
  const _explicitUndefined = browserCase(s<{ email: string }>())({
    description: "explicit undefined declares nothing",
    needs: undefined,
    steps: [
      {
        id: "s1",
        intent: "i",
        action: async (_page, { email }) => {
          void email;
        },
      },
    ],
  });
  void _explicitUndefined;

  // ---------------------------------------------------------------------
  // 5. Zero-arg form for journeys with no logical input — including inside an
  // extension contract, where PageType still infers.
  // ---------------------------------------------------------------------
  const noNeedsCase = browserCase()({
    description: "an anonymous visitor reaches the marketing page",
    steps: [
      {
        id: "visit",
        intent: "open the landing page",
        action: async (page) => {
          void page.url();
        },
      },
    ],
    expect: [{ id: "renders", dom: { visible: { role: "heading" } } }],
  });
  const _assignableAsCase: BrowserContractCase = noNeedsCase;
  void _assignableAsCase;

  const _zeroArgExtension = ext("extension.zero", {
    cases: {
      ok: browserCase()({
        description: "no logical input, extension page",
        steps: [
          {
            id: "open",
            intent: "open the native side panel",
            action: async (page) => {
              const handle = await page.extension.sidePanel.open();
              await handle.close();
            },
          },
        ],
      }),
    },
  });
  void _zeroArgExtension;

  // Still one declaration site in the zero-arg form.
  const _zeroArgDoubleDeclared = browserCase()({
    description: "declares needs without a factory schema",
    // @ts-expect-error -- `needs` is owned by the factory in BOTH forms.
    needs: s<{ email: string }>(),
    steps: [],
  });
  void _zeroArgDoubleDeclared;

  // ---------------------------------------------------------------------
  // 6. The returned case is accepted by the real contract factory, and the
  // resulting `.case()` ref carries the per-case Needs.
  // ---------------------------------------------------------------------
  const journeys = app("auth.signIn", {
    cases: { signIn: typedInput, landing: noNeedsCase },
  });

  const signInRef = journeys.case("signIn");
  type SignInInput = typeof signInRef extends { __phantom_inputs?: infer I }
    ? I
    : never;
  const _signInInput: SignInInput = { email: "a@b.c", password: "pw" };
  // @ts-expect-error -- proves the ref input is Needs, not `any`.
  const _signInInputNotAny: SignInInput = { completelyWrongField: "x" };
  void _signInInput;
  void _signInInputNotAny;

  // The deprecated factory keeps working (it is the escape hatch for a
  // standalone, client-less, non-default-page case).
  const _deprecated = defineBrowserCase<{ email: string }, ExtensionPage>({
    description: "explicit generics, standalone",
    needs: s<{ email: string }>(),
    steps: [
      {
        id: "open",
        intent: "open the native side panel",
        action: async (page, input) => {
          void input.email;
          const handle = await page.extension.sidePanel.open();
          await handle.close();
        },
      },
    ],
  });
  void _deprecated;
}

// =============================================================================
// Regression: a case body written against the EXPORTED `BrowserCaseBody<N>`
// annotation must survive the factory.
//
// `BrowserCaseBody` carries the `needs?: never` single-declaration guard, so a
// bare `C & { needs: SchemaLike<N> }` return type intersects `never` with a
// required property and collapses `needs` — taking core's `InferCaseInput` (and
// with it the whole `.case()` I/O chain) down to `never`. The return type drops
// the guarded key first (`Omit<C, "needs" | "steps"> & ...`), which is what
// these assert.
// =============================================================================

{
  type Needs = { email: string };

  const preAnnotated: BrowserCaseBody<Needs> = {
    description: "pre-annotated case body",
    steps: [
      {
        id: "s1",
        intent: "submit the email",
        action: async (_page, { email }) => {
          void email;
        },
      },
    ],
  };

  const built = browserCase(s<Needs>())(preAnnotated);

  // `needs` must be the schema, NOT `never`.
  const _needsUsable: SchemaLike<Needs> = built.needs;
  const _needsNotNever: [(typeof built)["needs"]] extends [never] ? true : false = false;
  // Other fields stay reachable (a collapsed intersection makes the whole
  // object unusable, not just its `needs`).
  const _descReachable: string = built.description;
  void _needsUsable;
  void _needsNotNever;
  void _descReachable;

  // The whole `.case()` I/O chain still works off the built case, and the ref's
  // input is EXACTLY Needs — asserted both ways, since a one-way `extends` also
  // holds for `never`.
  const preContract = app("auth.signUp", { cases: { ok: built } });
  const preRef = preContract.case("ok");
  type PreRefInput = typeof preRef extends { __phantom_inputs?: infer I } ? I : never;
  const _inputIsExactlyNeeds: [PreRefInput] extends [Needs]
    ? [Needs] extends [PreRefInput]
      ? true
      : false
    : false = true;
  void _inputIsExactlyNeeds;
}
