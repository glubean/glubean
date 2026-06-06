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

test("parseSource parses modern TS (satisfies / angle assertion / const T / decorators / import attrs / using) + collects comments", () => {
  // None of these throw — the whole point of @babel/parser over acorn-typescript.
  for (const src of [
    "export const a = ({ x: 1 } satisfies Record<string, number>);", // satisfies operator
    "export const b = <Foo>bar;",                                     // .ts angle-bracket assertion
    "export const c = <const T,>(x: T) => x;",                        // const type param
    "@dec export class D {}",                                          // decorator
    "import data from './x.json' with { type: 'json' };\nexport const e = data;", // import attributes
    "export const f = () => { using r = open(); return 1; };",        // using declaration
    "function satisfies(y: number) { return y; }\nexport const g = satisfies(1);", // `satisfies` as a plain identifier
  ]) {
    expect(() => parseSource(src)).not.toThrow();
  }
  const sf = parseSource("// @contract\nexport const x = 1;");
  expect(sf.program.type).toBe("Program");
  expect(sf.comments.some((c) => c.text.includes("@contract"))).toBe(true);
});

test("parseSource handles both decorator placements (legacy + modern) and accessor fields", () => {
  for (const src of [
    "@dec export class A { constructor(@p x: string) {} }", // legacy: @dec-export + parameter decorator
    "export @dec class B {}",                                // modern: decorator after export
    "export class C { @dec accessor x = 1; }",               // accessor field + member decorator
    "@dec export class A {}\nexport @dec class B {}",        // both placements mixed in one file
  ]) {
    expect(() => parseSource(src)).not.toThrow();
  }
});

test("an identifier named `satisfies` is preserved (call / member / operand)", () => {
  const sf = parseSource(
    [
      "function satisfies(y) { return y; }",
      "export const c = () => { return satisfies(1); };",
      "export const d = satisfies.foo;",
      "export const e = satisfies + 1;",
    ].join("\n"),
  );
  const callees: string[] = [];
  const members: string[] = [];
  walk(sf.program as AnyNode, (n) => {
    if (n.type === "CallExpression") {
      const callee = n.callee as AnyNode;
      if (callee.type === "Identifier") callees.push(callee.name as string);
    }
    if (n.type === "MemberExpression") {
      const obj = n.object as AnyNode;
      if (obj.type === "Identifier") members.push(obj.name as string);
    }
  });
  expect(callees).toEqual(["satisfies"]);
  expect(members).toEqual(["satisfies"]);
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
  forEachExportedConst(sf, (_stmt, decl) => {
    expect((decl.id as AnyNode).type).toBe("Identifier"); // contract: only identifiers reach the callback
    names.push((decl.id as AnyNode).name as string);
  });
  expect(names).toEqual(["a", "b"]); // c (not exported), d (let), {e}/[f] (destructured) excluded
});

test("hasLeadingMarker: matches across intervening comments, rejects trailing comments", () => {
  const a = parseSource("// @flow\n// a description\nexport const f = 1;");
  let an: AnyNode | undefined;
  forEachExportedConst(a, (s) => { an = s; });
  expect(hasLeadingMarker(a, an!, "flow")).toBe(true);

  const b = parseSource("const prev = 1; // @flow\nexport const g = 2;");
  let bn: AnyNode | undefined;
  forEachExportedConst(b, (s) => { bn = s; });
  expect(hasLeadingMarker(b, bn!, "flow")).toBe(false);
});

test("propertyNameText reads identifier / string / numeric / computed-string / computed-template / shorthand keys", () => {
  const src = "export const o = { ident: 1, \"str-key\": 2, 0: 3, [\"comp\"]: 4, [`tpl`]: 5, shorthand };";
  const sf = parseSource(src);
  let obj: AnyNode | undefined;
  forEachExportedConst(sf, (_s, d) => { obj = objectFromExpression(d.init as AnyNode); });
  const names = (obj!.properties as AnyNode[])
    .filter((p) => p.type === "ObjectProperty")
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
