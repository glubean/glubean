import { assertEquals } from "@std/assert";
import {
  classifyHostnameBlockReason,
  classifyIpBlockReason,
  isAllowedPort,
  isAllowedProtocol,
  isIpLiteral,
  resolveUrlPort,
} from "./network_policy.ts";

Deno.test("network policy: blocks localhost hostnames", () => {
  assertEquals(classifyHostnameBlockReason("localhost"), "blocked_hostname");
  assertEquals(
    classifyHostnameBlockReason("metadata.google.internal"),
    "blocked_hostname",
  );
  assertEquals(classifyHostnameBlockReason("api.example.com"), undefined);
});

Deno.test("network policy: blocks private and metadata IPs", () => {
  assertEquals(classifyIpBlockReason("127.0.0.1"), "loopback_ip");
  assertEquals(classifyIpBlockReason("10.2.3.4"), "private_ip");
  assertEquals(classifyIpBlockReason("172.20.5.1"), "private_ip");
  assertEquals(classifyIpBlockReason("192.168.1.10"), "private_ip");
  assertEquals(classifyIpBlockReason("169.254.169.254"), "metadata_ip");
  assertEquals(classifyIpBlockReason("8.8.8.8"), undefined);
});

Deno.test("network policy: identifies IP literals", () => {
  assertEquals(isIpLiteral("127.0.0.1"), true);
  assertEquals(isIpLiteral("::1"), true);
  assertEquals(isIpLiteral("[::1]"), true);
  assertEquals(isIpLiteral("api.example.com"), false);
});

Deno.test("network policy: protocol and port checks", () => {
  assertEquals(isAllowedProtocol("http:"), true);
  assertEquals(isAllowedProtocol("https:"), true);
  assertEquals(isAllowedProtocol("ftp:"), false);
  assertEquals(isAllowedPort(443, [80, 443]), true);
  assertEquals(isAllowedPort(22, [80, 443]), false);
});

Deno.test("network policy: resolves default URL ports", () => {
  assertEquals(resolveUrlPort(new URL("http://example.com/health")), 80);
  assertEquals(resolveUrlPort(new URL("https://example.com/health")), 443);
  assertEquals(resolveUrlPort(new URL("https://example.com:8443/health")), 8443);
});
