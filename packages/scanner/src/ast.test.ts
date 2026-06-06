import { test, expect } from "vitest";
import {
  parseSource,
  forEachExportedConst,
  hasLeadingMarker,
  propertyNameText,
  unwrapExpression,
  stringFromExpression,
  objectFromExpression,
  objectProperty,
  stringProperty,
  findPropertyCall,
  walk,
  lineOf,
  hasExportModifier,
  type AnyNode,
} from "./ast.js";

test("parseSource parses TS syntax (annotations, generics, satisfies, as) + collects comments", () => {
  const src = `
// @contract
export const x: Record<string, number> = { a: 1 } satisfies Record<string, number>;
export const y = foo<Bar<{ id: string }>>("z") as const;
`;
  const sf = parseSource(src);
  expect(sf.program.type).toBe("Program");
  expect(sf.comments.some((c) => c.text.includes("@contract"))).toBe(true);
});

test("forEachExportedConst yields export const declarators; skips non-export/non-const/destructuring", () => {
  const src = `
export const a = 1, b = 2;
const c = 3;
export let d = 4;
export const { e } = obj;
export const [f] = arr;
`;
  const sf = parseSource(src);
  const names: string[] = [];
  // No test-side filter: forEachExportedConst itself must skip destructuring,
  // so every `decl.id` reaching the callback is an Identifier.
  forEachExportedConst(sf, (_stmt, decl) => {
    expect((decl.id as AnyNode).type).toBe("Identifier");
    names.push((decl.id as AnyNode).name as string);
  });
  expect(names).toEqual(["a", "b"]); // c (not exported), d (let), {e}/[f] (destructured) excluded
});

test("normalizeSatisfies preserves `satisfies` used as an export-renamed identifier", () => {
  // `export { satisfies as sat }` — `satisfies` is an identifier, not the operator.
  const src = "const satisfies = 1; export { satisfies as sat };";
  expect(() => parseSource(src)).not.toThrow();
});

test("an identifier named `satisfies` is never rewritten (no corruption) in any position", () => {
  // The discriminator is the PRECEDING token, so `satisfies` used as a name —
  // call, generic call, member, operand, after a keyword — keeps its identity.
  const src = [
    "function satisfies(y) { return y; }",
    "export const c = () => { return satisfies(1); };", // after `return`
    "export const d = satisfies.foo;",                   // member
    "export const e = satisfies + 1;",                   // operand
  ].join("\n");
  const callees: string[] = [];
  const members: string[] = [];
  const sf = parseSource(src);
  walk(sf.program as AnyNode, (n) => {
    if (n.type === "CallExpression") {
      const callee = (n as AnyNode).callee as AnyNode;
      if (callee.type === "Identifier") callees.push(callee.name as string);
    }
    if (n.type === "MemberExpression") {
      const obj = (n as AnyNode).object as AnyNode;
      if (obj.type === "Identifier") members.push(obj.name as string);
    }
  });
  expect(callees).toEqual(["satisfies"]); // not "as"
  expect(members).toEqual(["satisfies"]); // satisfies.foo intact
});

test("the satisfies OPERATOR is normalized for all value operands + type shapes", () => {
  // Preceded by a value → operator → rewritten so acorn-typescript can parse it.
  for (const s of [
    "export const a = ({ x: 1 } satisfies Record<string, number>);", // } + generic type (common Glubean form)
    "export const b = (x satisfies (n: number) => void);",            // ident + parenthesized/function type
    "export const c = (arr[0] satisfies (A | B));",                   // ] + union
    "export const d = (check(y) satisfies Foo);",                     // ) operand
    "export const e = (h! satisfies Bar);",                           // ! non-null operand
    "export const f = (this satisfies Spec);",                        // value-keyword operand
  ]) {
    expect(() => parseSource(s)).not.toThrow();
  }
});

test("parseSource throws only on syntax acorn-typescript genuinely can't parse (→ P1 skip+warn)", () => {
  expect(() => parseSource("export const x = <Foo>bar;")).toThrow();   // angle-bracket assertion (JSX ambiguity)
  expect(() => parseSource("export const x = bar as Foo;")).not.toThrow(); // recommended form is fine
});

test("hasLeadingMarker: matches across intervening comments, rejects trailing comments", () => {
  // Marker followed by a description comment before the export → still matches.
  const a = parseSource("// @flow\n// a description\nexport const f = 1;");
  let an: AnyNode | undefined;
  forEachExportedConst(a, (s) => { an = s; });
  expect(hasLeadingMarker(a, an!, "flow")).toBe(true);
  // Marker as a TRAILING comment on the previous statement → not this node's.
  const b = parseSource("const prev = 1; // @flow\nexport const g = 2;");
  let bn: AnyNode | undefined;
  forEachExportedConst(b, (s) => { bn = s; });
  expect(hasLeadingMarker(b, bn!, "flow")).toBe(false);
});

test("hasLeadingMarker detects an immediately-preceding // @marker only", () => {
  const src = `
// @flow
export const f = 1;
export const g = 2;
`;
  const sf = parseSource(src);
  const byName = new Map<string, AnyNode>();
  forEachExportedConst(sf, (stmt, decl) => byName.set((decl.id as AnyNode).name as string, stmt));
  expect(hasLeadingMarker(sf, byName.get("f")!, "flow")).toBe(true);
  expect(hasLeadingMarker(sf, byName.get("g")!, "flow")).toBe(false);
});

test("propertyNameText reads identifier / string / numeric / computed-string / computed-template / shorthand keys", () => {
  // Bare `` `tpl`: `` is invalid JS — template/string keys must be computed (`[...]`).
  const src = "export const o = { ident: 1, \"str-key\": 2, 0: 3, [\"comp\"]: 4, [`tpl`]: 5, shorthand };";
  const sf = parseSource(src);
  let obj: AnyNode | undefined;
  forEachExportedConst(sf, (_s, d) => { obj = objectFromExpression(d.init as AnyNode); });
  const names = (obj!.properties as AnyNode[])
    .filter((p) => p.type === "Property")
    .map((p) => propertyNameText(p));
  expect(names).toEqual(["ident", "str-key", "0", "comp", "tpl", "shorthand"]);
});

test("unwrapExpression strips as / satisfies / ! wrappers before reading the value", () => {
  const src = `
export const a = ("hi" as string);
export const b = "yo" satisfies string;
export const c = x!;
`;
  const sf = parseSource(src);
  const got: Record<string, string | undefined> = {};
  forEachExportedConst(sf, (_s, d) => {
    got[(d.id as AnyNode).name as string] = stringFromExpression(d.init as AnyNode);
  });
  expect(got.a).toBe("hi");
  expect(got.b).toBe("yo");
  expect(got.c).toBeUndefined(); // x! is not a string literal
  // unwrapExpression on a plain literal returns the literal node itself
  expect(unwrapExpression(undefined)).toBeUndefined();
});

test("stringFromExpression: literal + no-substitution template yes; substitution template no", () => {
  const src = "export const a = \"lit\";\nexport const b = `notmpl`;\nexport const c = `has ${x}`;";
  const sf = parseSource(src);
  const got: Record<string, string | undefined> = {};
  forEachExportedConst(sf, (_s, d) => {
    got[(d.id as AnyNode).name as string] = stringFromExpression(d.init as AnyNode);
  });
  expect(got.a).toBe("lit");
  expect(got.b).toBe("notmpl");
  expect(got.c).toBeUndefined();
});

test("objectProperty / stringProperty read named props and skip spread siblings", () => {
  const src = `export const o = { ...base, id: "x", n: 1 };`;
  const sf = parseSource(src);
  let obj: AnyNode | undefined;
  forEachExportedConst(sf, (_s, d) => { obj = objectFromExpression(d.init as AnyNode); });
  expect(stringProperty(obj!, "id")).toBe("x");
  expect(objectProperty(obj!, "n")).toBeTruthy();
  expect(objectProperty(obj!, "missing")).toBeUndefined();
});

test("findPropertyCall walks the chain spine, never into argument/callback bodies", () => {
  const src = `
export const t = test("id").meta({ name: "n" }).step("s1", async () => { helper.inner("x"); });
`;
  const sf = parseSource(src);
  let init: AnyNode | undefined;
  forEachExportedConst(sf, (_s, d) => { init = d.init as AnyNode; });
  expect(findPropertyCall(init!, "meta")).toBeTruthy();
  expect(findPropertyCall(init!, "step")).toBeTruthy();
  expect(findPropertyCall(init!, "inner")).toBeUndefined(); // inside a callback body
  expect(findPropertyCall(init!, "nope")).toBeUndefined();
});

test("satisfies normalization preserves a string literal that contains the word 'satisfies'", () => {
  const src = `export const id = flow("id satisfies policy");`;
  const sf = parseSource(src);
  let v: string | undefined;
  forEachExportedConst(sf, (_s, d) => {
    const call = d.init as AnyNode;
    v = stringFromExpression((call.arguments as AnyNode[])[0]);
  });
  expect(v).toBe("id satisfies policy");
});

test("walk visits descendants; lineOf is 1-based; hasExportModifier detects the export", () => {
  const src = `\nexport const o = { a: { b: 1 } };`; // o is on line 2
  const sf = parseSource(src);
  let stmt: AnyNode | undefined, decl: AnyNode | undefined;
  forEachExportedConst(sf, (s, d) => { stmt = s; decl = d; });
  expect(lineOf(decl!)).toBe(2);
  expect(hasExportModifier(stmt!)).toBe(true);
  let count = 0;
  walk(sf.program as AnyNode, () => { count++; });
  expect(count).toBeGreaterThan(3);
});
