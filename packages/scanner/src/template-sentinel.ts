const TEMPLATE_RE = /\$[A-Za-z_]\w*/g;
const VARIANT_PREFIX_RE = /^(?:each|pick):/;

export function stripVariantPrefix(id: string): string {
  return id.replace(VARIANT_PREFIX_RE, "");
}

export function hasTemplatePlaceholders(id: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(stripVariantPrefix(id));
}

export function templateIdToRegExp(id: string): RegExp | undefined {
  const normalized = stripVariantPrefix(id);
  TEMPLATE_RE.lastIndex = 0;
  if (!TEMPLATE_RE.test(normalized)) return undefined;

  TEMPLATE_RE.lastIndex = 0;
  let lastIndex = 0;
  let pattern = "^";
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_RE.exec(normalized)) !== null) {
    pattern += escapeRegExp(normalized.slice(lastIndex, match.index));
    pattern += ".*";
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegExp(normalized.slice(lastIndex));
  pattern += "$";
  return new RegExp(pattern, "i");
}

export function matchesTemplateId(templateId: string, concreteId: string): boolean {
  const normalizedTemplate = stripVariantPrefix(templateId).toLowerCase();
  const normalizedConcrete = stripVariantPrefix(concreteId).toLowerCase();
  if (normalizedTemplate === normalizedConcrete) return true;
  return templateIdToRegExp(templateId)?.test(stripVariantPrefix(concreteId)) ?? false;
}

export function matchesTemplateFilter(templateId: string, filter: string): boolean {
  const normalizedFilter = stripVariantPrefix(filter).toLowerCase().trim();
  if (!normalizedFilter) return true;

  const normalizedTemplate = stripVariantPrefix(templateId).toLowerCase();
  if (normalizedTemplate.includes(normalizedFilter)) return true;
  if (matchesTemplateId(templateId, normalizedFilter)) return true;

  const prefix = normalizedTemplate.split(TEMPLATE_RE)[0] ?? "";
  return prefix.length > 0 && normalizedFilter.startsWith(prefix);
}

export function findTemplateMatch<T extends { id: string }>(
  items: readonly T[],
  concreteId: string,
): T | undefined {
  const normalizedConcrete = stripVariantPrefix(concreteId).toLowerCase();
  const exact = items.find(
    (item) => stripVariantPrefix(item.id).toLowerCase() === normalizedConcrete,
  );
  return exact ?? items.find((item) => matchesTemplateId(item.id, concreteId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
