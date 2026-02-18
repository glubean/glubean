/**
 * Parameterized search — run different query variations with test.pick.
 *
 * Each example in search-examples.json defines a search term and expected
 * outcome. In VS Code, CodeLens buttons appear above the test so you can
 * click a specific example to run.
 *
 * Run all:      deno task explore
 * Pick one:     deno run -A jsr:@glubean/cli run explore/search.test.ts --pick by-name
 * Pick another: deno run -A jsr:@glubean/cli run explore/search.test.ts --pick no-results
 */
import { test } from "@glubean/sdk";
import examples from "../data/search-examples.json" with { type: "json" };

export const searchProducts = test.pick(examples)(
  "search-$_pick",
  async ({ http, vars, expect, log }, { q, expected }) => {
    const baseUrl = vars.require("BASE_URL");

    const res = await http
      .get(`${baseUrl}/products/search`, { searchParams: { q } })
      .json<{ products: { title: string }[]; total: number }>();

    expect(res.total).toBeGreaterThan(expected.minResults - 1);

    if (expected.titleContains && res.products.length > 0) {
      expect(res.products[0].title.toLowerCase()).toContain(
        expected.titleContains,
      );
    }

    log(`"${q}" → ${res.total} results`);
  },
);
