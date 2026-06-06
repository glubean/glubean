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

test("normalizeSatisfies rewrites the operator even when the TYPE starts with `(`", () => {
  // `x satisfies (a:number)=>void` is the operator with a parenthesized/function
  // type; acorn-typescript can't parse raw `satisfies`, so it must be normalized.
  // A genuine call to an identifier named `satisfies` must NOT be rewritten.
  expect(() => parseSource("export const a = (x satisfies (n: number) => void);")).not.toThrow();
  expect(() => parseSource("export const b = (x satisfies (Foo | Bar));")).not.toThrow();
  expect(() => parseSource("function satisfies(y) { return y; } export const c = satisfies(1);")).not.toThrow();
  // Operand ends with a non-null assertion `!`, then a parenthesized/function type.
  expect(() => parseSource("export const h = (handler! satisfies (x: string) => string);")).not.toThrow();
  // Operand ends with `)` / `]` then a parenthesized type.
  expect(() => parseSource("export const d = (check(a) satisfies (B));")).not.toThrow();
  expect(() => parseSource("export const e = (arr[0] satisfies (B));")).not.toThrow();
});

test("parseSource throws on .ts angle-bracket type assertions (known acorn-typescript limit)", () => {
  // acorn-typescript always treats `<...>` as JSX; `<Foo>bar` cannot be parsed
  // (no plugin toggle fixes it). Glubean code uses `expr as T`. This locks the
  // limitation so extractors (P1+) wrap parseSource in try/catch (skip + warn).
  expect(() => parseSource("export const x = <Foo>bar;")).toThrow();
  // The recommended form parses fine:
  expect(() => parseSource("export const x = bar as Foo;")).not.toThrow();
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
