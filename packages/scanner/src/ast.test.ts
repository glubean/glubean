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
`;
  const sf = parseSource(src);
  const names: string[] = [];
  forEachExportedConst(sf, (_stmt, decl) => {
    const id = decl.id as AnyNode | undefined;
    if (id?.type === "Identifier") names.push(id.name as string);
  });
  expect(names).toEqual(["a", "b"]);
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
