import { describe, it, expect } from "vitest";
import { inferJsonSchema, truncateDeep } from "./schema_inference.js";

// ── inferJsonSchema ─────────────────────────────────────────────────────────

describe("inferJsonSchema", () => {
  it("infers string", () => {
    expect(inferJsonSchema("hello")).toEqual({ type: "string" });
  });

  it("infers integer", () => {
    expect(inferJsonSchema(42)).toEqual({ type: "integer" });
  });

  it("infers number (float)", () => {
    expect(inferJsonSchema(3.14)).toEqual({ type: "number" });
  });

  it("infers boolean", () => {
    expect(inferJsonSchema(true)).toEqual({ type: "boolean" });
  });

  it("infers null", () => {
    expect(inferJsonSchema(null)).toEqual({ type: "null" });
  });

  it("infers undefined as empty schema", () => {
    expect(inferJsonSchema(undefined)).toEqual({});
  });

  it("infers simple object", () => {
    const schema = inferJsonSchema({ name: "Alice", age: 30 });
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name", "age"],
    });
  });

  it("infers nested object", () => {
    const schema = inferJsonSchema({
      user: { name: "Bob", active: true },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            active: { type: "boolean" },
          },
          required: ["name", "active"],
        },
      },
      required: ["user"],
    });
  });

  it("infers array with items schema from first element", () => {
    const schema = inferJsonSchema([
      { id: 1, title: "Product A" },
      { id: 2, title: "Product B" },
      { id: 3, title: "Product C" },
    ]);
    expect(schema).toEqual({
      type: "array",
      _itemCount: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
        },
        required: ["id", "title"],
      },
    });
  });

  it("infers empty array", () => {
    expect(inferJsonSchema([])).toEqual({
      type: "array",
      _itemCount: 0,
      items: {},
    });
  });

  it("handles object with nullable field", () => {
    const schema = inferJsonSchema({ name: "Alice", bio: null });
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        bio: { type: "null" },
      },
      required: ["name"],
    });
  });

  it("handles deeply nested (respects depth limit)", () => {
    // Build a 15-level deep object
    let obj: unknown = "leaf";
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    const schema = inferJsonSchema(obj);
    // Should not throw, and deep levels become {}
    expect(schema.type).toBe("object");
  });

  it("infers real-world API response", () => {
    const response = {
      total: 194,
      skip: 0,
      limit: 30,
      products: [
        { id: 1, title: "Phone", price: 9.99, tags: ["electronics"] },
        { id: 2, title: "Laptop", price: 999, tags: ["electronics", "computers"] },
      ],
    };
    const schema = inferJsonSchema(response);
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.total).toEqual({ type: "integer" });
    expect(props.products.type).toBe("array");
    expect(props.products._itemCount).toBe(2);
  });
});

// ── truncateDeep ──────────────────────────────────────────────────────

describe("truncateDeep", () => {
  it("returns primitives unchanged", () => {
    expect(truncateDeep("hello")).toBe("hello");
    expect(truncateDeep(42)).toBe(42);
    expect(truncateDeep(null)).toBe(null);
    expect(truncateDeep(undefined)).toBe(undefined);
  });

  it("keeps short arrays unchanged", () => {
    expect(truncateDeep([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("truncates long arrays", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = truncateDeep(input, { maxItems: 3 });
    expect(result).toEqual([1, 2, 3, "(7 more items truncated)"]);
  });

  it("truncates nested arrays in objects", () => {
    const input = {
      name: "test",
      items: [1, 2, 3, 4, 5],
      meta: { tags: ["a", "b", "c", "d", "e", "f"] },
    };
    const result = truncateDeep(input, { maxItems: 3 }) as Record<string, unknown>;
    expect(result.name).toBe("test");
    expect(result.items).toEqual([1, 2, 3, "(2 more items truncated)"]);
    const meta = result.meta as Record<string, unknown>;
    expect(meta.tags).toEqual(["a", "b", "c", "(3 more items truncated)"]);
  });

  it("truncates arrays of objects", () => {
    const input = [
      { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
    ];
    const result = truncateDeep(input, { maxItems: 2 }) as unknown[];
    expect(result).toHaveLength(3); // 2 items + annotation
    expect(result[0]).toEqual({ id: 1 });
    expect(result[1]).toEqual({ id: 2 });
    expect(result[2]).toBe("(3 more items truncated)");
  });

  it("handles empty arrays", () => {
    expect(truncateDeep([])).toEqual([]);
  });

  it("handles empty objects", () => {
    expect(truncateDeep({})).toEqual({});
  });

  it("truncates long strings", () => {
    const longStr = "a".repeat(200);
    const result = truncateDeep(longStr) as string;
    expect(result).toBe("a".repeat(80) + "...[200]");
  });

  it("truncates long strings with custom maxStringLength", () => {
    const result = truncateDeep("hello world", { maxStringLength: 5 }) as string;
    expect(result).toBe("hello...[11]");
  });

  it("keeps short strings unchanged", () => {
    expect(truncateDeep("short")).toBe("short");
  });

  it("truncates long strings inside objects", () => {
    const tileData = "x".repeat(5000);
    const input = { name: "tile", data: tileData, id: 42 };
    const result = truncateDeep(input) as Record<string, unknown>;
    expect(result.name).toBe("tile");
    expect(result.id).toBe(42);
    expect((result.data as string).length).toBeLessThan(100);
    expect((result.data as string)).toMatch(/\.\.\.\[\d+\]$/);
  });

  it("truncates long strings inside arrays", () => {
    const input = [{ blob: "z".repeat(2000) }];
    const result = truncateDeep(input) as Array<Record<string, unknown>>;
    expect((result[0].blob as string)).toMatch(/\.\.\.\[\d+\]$/);
  });
});
