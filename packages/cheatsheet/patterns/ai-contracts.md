# AI Contract Testing

Test AI/LLM endpoints with structured output validation and consistency checks.

## Setup (see configure.md for full AI plugin setup)

```typescript
// config/ai.ts — uses Vercel AI SDK + OpenAI
import { configure, definePlugin } from "@glubean/sdk";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ZodType } from "zod";

export const { ai } = configure({
  plugins: {
    ai: definePlugin((rt) => {
      const openai = createOpenAI({ apiKey: rt.requireSecret("OPENAI_API_KEY") });
      return {
        generate: <T>(schema: ZodType<T>, prompt: string, model = "gpt-4o-mini") =>
          generateObject({ model: openai(model), schema, prompt }),
      };
    }),
  },
});
```

## Schema + semantic assertion

```typescript
import { test } from "@glubean/sdk";
import { z } from "zod";
import { ai } from "../../config/ai.ts";

const SentimentSchema = z.object({
  sentiment: z.enum(["positive", "negative", "neutral"]),
  confidence: z.number().min(0).max(1),
  keywords: z.array(z.string()).min(1),
});

export const sentimentCheck = test(
  { id: "ai-sentiment", name: "sentiment analysis contract", tags: ["ai"] },
  async ({ expect, log }) => {
    const { object, usage } = await ai.generate(
      SentimentSchema,
      'Analyze the sentiment: "This product is absolutely fantastic, best purchase ever!"',
    );

    // Structure
    expect(object.sentiment).toBeDefined();
    expect(object.confidence).toBeGreaterThan(0);

    // Semantics — the real value
    expect(object.sentiment).toBe("positive");
    expect(object.confidence).toBeGreaterThan(0.7);

    log(`Sentiment: ${object.sentiment} (${object.confidence})`);
    log(`Tokens: ${usage.totalTokens}`);
  },
);
```

## Consistency across runs

Run same prompt N times, check outputs are stable.

```typescript
const CategorySchema = z.object({
  category: z.enum(["bug", "feature", "question", "docs"]),
  priority: z.enum(["low", "medium", "high"]),
});

export const consistencyCheck = test(
  { id: "ai-consistency", name: "classification stability", tags: ["ai"] },
  async ({ expect, log }) => {
    const prompt = 'Classify: "App crashes on login with null pointer in auth.ts line 42"';

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ai.generate(CategorySchema, prompt)),
    );

    const categories = results.map((r) => r.object.category);
    const allBug = categories.every((c) => c === "bug");
    expect(allBug).toBe(true);

    log(`Results: ${categories.join(", ")} — ${allBug ? "stable" : "unstable"}`);
  },
);
```

## Ambiguous input — majority check

```typescript
export const ambiguousCheck = test(
  { id: "ai-ambiguous", name: "ambiguous input majority", tags: ["ai"] },
  async ({ expect, log }) => {
    const prompt = 'Classify: "Would be nice to have dark mode, light theme hurts my eyes"';
    const N = 5;

    const results = await Promise.all(
      Array.from({ length: N }, () => ai.generate(CategorySchema, prompt)),
    );

    const categories = results.map((r) => r.object.category);
    const counts = new Map<string, number>();
    for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);

    const [topCategory, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(topCount / N).toBeGreaterThanOrEqual(0.6);  // At least 60% agree

    log(`Majority: ${topCategory} (${topCount}/${N})`);
  },
);
```

## Testing patterns for AI endpoints

- **Schema contract** — Zod enforces structure, assertions verify semantics
- **Consistency** — Run N times, check stability (clear cases: 100%, ambiguous: ≥60%)
- **Regression** — Save known-good outputs, compare against new model versions
- **Token usage** — Log and optionally assert on token counts for cost control
