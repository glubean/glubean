/**
 * Heuristic routeKey normalization (M3-e).
 *
 * Until explicit routeKeys / a contract catalog land (M8), the load sink derives
 * an endpoint's routeKey from the request's METHOD + pathname. Raw pathnames are
 * high-cardinality (`/items/42`, `/items/43`, `/orders/<uuid>` …), so without
 * normalization every id spawns its own endpoint bucket and the LoadArtifact's
 * endpoint aggregates explode. This collapses id-LIKE path segments to `:id` so
 * the same logical endpoint aggregates together.
 *
 * The heuristic is deliberately CONSERVATIVE — it only collapses segments that are
 * unambiguously ids (pure integers, UUIDs, Mongo ObjectIds, long hex hashes) — so
 * real route words (`/api/v2`, `/users/me`) are never merged. Anything it touches
 * stays flagged `routeKeyHeuristic: true` so consumers know it was inferred.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i; // Mongo ObjectId
const LONG_HEX_RE = /^[0-9a-f]{32,}$/i; // md5 / sha-* / other hex digests

/** Whether a single path segment looks like a high-cardinality id (→ `:id`). */
export function looksLikeIdSegment(segment: string): boolean {
  if (segment === "") return false;
  if (/^\d+$/.test(segment)) return true; // integer id
  if (UUID_RE.test(segment)) return true;
  if (OBJECT_ID_RE.test(segment)) return true;
  if (LONG_HEX_RE.test(segment)) return true;
  return false;
}

/** Collapse id-like segments of a pathname to `:id` (query/hash stripped). */
export function normalizeRoutePath(pathname: string): string {
  if (!pathname) return "";
  // Defensive: pathnames from the engine carry no query/hash, but strip just in case.
  const q = pathname.search(/[?#]/);
  const path = q >= 0 ? pathname.slice(0, q) : pathname;
  if (path === "/" || path === "") return path;
  return path
    .split("/")
    .map((seg) => (looksLikeIdSegment(seg) ? ":id" : seg))
    .join("/");
}

/** Split an engine/user `target` (`"METHOD /pathname"`) into its method + path. */
function splitTarget(target: string | undefined): { method?: string; path?: string } {
  if (!target) return {};
  const sp = target.indexOf(" ");
  if (sp < 0) return { path: target };
  return { method: target.slice(0, sp), path: target.slice(sp + 1) };
}

/** Extract the pathname from a trace's `url`, or undefined if absent/unparseable. */
function pathnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    // Relative URL — resolve against a dummy base to extract the pathname.
    try {
      return new URL(url, "http://glubean.invalid").pathname;
    } catch {
      return undefined;
    }
  }
}

/** A trace's resolved method + heuristic routeKey. */
export interface ResolvedRoute {
  method: string;
  routeKey: string;
}

/**
 * Resolve a request's method + heuristic routeKey from a trace's fields.
 *
 * HTTP path normalization (method prefix + id-like segments → `:id`) applies to
 * HTTP traces — `protocol === "http"` AND legacy traces that OMIT `protocol` but
 * carry HTTP `method`/`url` fields. For HTTP: method precedence is explicit
 * `method` > the method embedded in `target` (`"POST /orders"`) > `"GET"` (so a
 * target-only trace keeps its real verb), and path precedence is `url` >
 * `target`'s path. Only an EXPLICIT non-http protocol (gRPC `"Service/Method"`,
 * custom protocols) is treated as non-HTTP: its `target` IS the routeKey
 * (normalizing it would fabricate a bogus HTTP route), used verbatim.
 */
export function resolveRouteKey(
  method: string | undefined,
  url: string | undefined,
  target: string | undefined,
  protocol: string | undefined,
): ResolvedRoute {
  // Only an explicit non-"http" protocol opts out of HTTP normalization; a missing
  // protocol is the legacy HTTP shape (method/url) and must still normalize.
  if (protocol !== undefined && protocol !== "http") {
    return { method: method ?? "", routeKey: target ?? "" };
  }
  const t = splitTarget(target);
  const resolvedMethod = method ?? t.method ?? "GET";
  const path = pathnameFromUrl(url) ?? t.path ?? "";
  return { method: resolvedMethod, routeKey: `${resolvedMethod} ${normalizeRoutePath(path)}` };
}
