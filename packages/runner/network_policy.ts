/**
 * Utilities for shared-serverless network guardrails.
 */

export const SHARED_SERVERLESS_BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

export const SHARED_SERVERLESS_METADATA_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure metadata endpoint
  "100.100.100.200", // Alibaba Cloud metadata endpoint
  "fd00:ec2::254", // AWS IPv6 metadata endpoint
]);

export function isIpLiteral(hostname: string): boolean {
  const normalized = unwrapIpBrackets(hostname.toLowerCase());
  return isIpv4(normalized) || isIpv6(normalized);
}

export function resolveUrlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export function isAllowedProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export function isAllowedPort(port: number, allowedPorts: number[]): boolean {
  return allowedPorts.includes(port);
}

export function classifyHostnameBlockReason(hostname: string): string | undefined {
  const normalized = hostname.toLowerCase();
  if (SHARED_SERVERLESS_BLOCKED_HOSTNAMES.has(normalized)) {
    return "blocked_hostname";
  }
  return undefined;
}

export function classifyIpBlockReason(ip: string): string | undefined {
  const normalized = unwrapIpBrackets(ip.toLowerCase());
  if (SHARED_SERVERLESS_METADATA_IPS.has(normalized)) {
    return "metadata_ip";
  }

  if (isIpv4(normalized)) {
    const octets = normalized.split(".").map((value) => Number(value));
    const [a, b] = octets;
    if (a === 127 || a === 0) return "loopback_ip";
    if (a === 10) return "private_ip";
    if (a === 192 && b === 168) return "private_ip";
    if (a === 172 && b >= 16 && b <= 31) return "private_ip";
    if (a === 169 && b === 254) return "link_local_ip";
    return undefined;
  }

  if (isIpv6(normalized)) {
    if (normalized === "::1") return "loopback_ip";
    if (normalized.startsWith("fe80:")) return "link_local_ip";
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return "private_ip";
    }
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      return classifyIpBlockReason(mapped);
    }
  }

  return undefined;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isIpv6(value: string): boolean {
  return value.includes(":");
}

function unwrapIpBrackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}
