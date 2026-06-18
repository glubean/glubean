import { describe, expect, it } from "vitest";

import { looksLikeIdSegment, normalizeRoutePath, resolveRouteKey } from "./route-key.js";

describe("route-key heuristic normalization (M3-e)", () => {
  describe("looksLikeIdSegment", () => {
    it("treats integers / UUIDs / ObjectIds / long hex as ids", () => {
      expect(looksLikeIdSegment("42")).toBe(true);
      expect(looksLikeIdSegment("0")).toBe(true);
      expect(looksLikeIdSegment("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(looksLikeIdSegment("507f1f77bcf86cd799439011")).toBe(true); // mongo objectid (24 hex)
      expect(looksLikeIdSegment("d41d8cd98f00b204e9800998ecf8427e")).toBe(true); // md5 (32 hex)
    });

    it("leaves real route words alone", () => {
      expect(looksLikeIdSegment("items")).toBe(false);
      expect(looksLikeIdSegment("v2")).toBe(false); // version, not a pure int
      expect(looksLikeIdSegment("me")).toBe(false);
      expect(looksLikeIdSegment("order-history")).toBe(false);
      expect(looksLikeIdSegment("abc123")).toBe(false); // mixed, not pure-int/hex-of-id-length
      expect(looksLikeIdSegment("")).toBe(false);
    });
  });

  describe("normalizeRoutePath", () => {
    it("collapses id-like segments to :id", () => {
      expect(normalizeRoutePath("/items/42")).toBe("/items/:id");
      expect(normalizeRoutePath("/users/42/orders/99")).toBe("/users/:id/orders/:id");
      expect(normalizeRoutePath("/orders/550e8400-e29b-41d4-a716-446655440000")).toBe("/orders/:id");
    });

    it("preserves non-id paths and structure", () => {
      expect(normalizeRoutePath("/")).toBe("/");
      expect(normalizeRoutePath("/api/v2/health")).toBe("/api/v2/health");
      expect(normalizeRoutePath("/users/me")).toBe("/users/me");
      expect(normalizeRoutePath("")).toBe("");
    });

    it("strips a query/hash before normalizing", () => {
      expect(normalizeRoutePath("/items/42?expand=true")).toBe("/items/:id");
      expect(normalizeRoutePath("/items/42#frag")).toBe("/items/:id");
    });
  });

  describe("resolveRouteKey — HTTP", () => {
    it("builds METHOD + normalized path from a full url", () => {
      expect(resolveRouteKey("GET", "http://127.0.0.1:8080/items/42", "GET /items/42", "http")).toEqual({
        method: "GET",
        routeKey: "GET /items/:id",
      });
    });

    it("falls back to the engine target when url is absent", () => {
      expect(resolveRouteKey("POST", undefined, "POST /orders", "http")).toEqual({
        method: "POST",
        routeKey: "POST /orders",
      });
    });

    it("recovers the method from a target-only trace (not defaulting to GET)", () => {
      // ctx.trace({ protocol: "http", target: "POST /orders" }) — no explicit method.
      expect(resolveRouteKey(undefined, undefined, "POST /orders", "http")).toEqual({
        method: "POST",
        routeKey: "POST /orders",
      });
      // A target-only PUT with an id keeps PUT + normalizes the id.
      expect(resolveRouteKey(undefined, undefined, "PUT /items/42", "http")).toEqual({
        method: "PUT",
        routeKey: "PUT /items/:id",
      });
    });

    it("defaults to GET only when no method is recoverable", () => {
      expect(resolveRouteKey(undefined, "http://h/items/1", undefined, "http")).toEqual({
        method: "GET",
        routeKey: "GET /items/:id",
      });
    });

    it("normalizes a legacy trace that omits protocol (just method/url)", () => {
      // ctx.trace({ method: "GET", url: "https://example.com/items/7" }) — no protocol.
      expect(resolveRouteKey("GET", "https://example.com/items/7", undefined, undefined)).toEqual({
        method: "GET",
        routeKey: "GET /items/:id",
      });
      // A bare host (no path) normalizes to "/", never an empty routeKey.
      expect(resolveRouteKey("GET", "https://example.com", undefined, undefined)).toEqual({
        method: "GET",
        routeKey: "GET /",
      });
    });

    it("two different ids produce the same routeKey (cardinality collapse)", () => {
      const a = resolveRouteKey("GET", "http://h/items/1", "GET /items/1", "http");
      const b = resolveRouteKey("GET", "http://h/items/2", "GET /items/2", "http");
      expect(a.routeKey).toBe(b.routeKey);
      expect(a.routeKey).toBe("GET /items/:id");
    });
  });

  describe("resolveRouteKey — non-HTTP", () => {
    it("uses a gRPC target verbatim (no method prefix, no :id mangling)", () => {
      expect(resolveRouteKey(undefined, undefined, "Service/Method", "grpc")).toEqual({
        method: "",
        routeKey: "Service/Method",
      });
    });

    it("uses a custom-protocol target verbatim, preserving any explicit method", () => {
      expect(resolveRouteKey("PUBLISH", undefined, "queue.orders", "amqp")).toEqual({
        method: "PUBLISH",
        routeKey: "queue.orders",
      });
    });
  });
});
