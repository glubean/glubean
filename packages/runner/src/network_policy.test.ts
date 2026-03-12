import { test, expect } from "vitest";
import {
  classifyHostnameBlockReason,
  classifyIpBlockReason,
  isAllowedPort,
  isAllowedProtocol,
  isIpLiteral,
  resolveUrlPort,
} from "./network_policy.js";

test("network policy: blocks localhost hostnames", () => {
  expect(classifyHostnameBlockReason("localhost")).toBe("blocked_hostname");
  expect(classifyHostnameBlockReason("metadata.google.internal")).toBe("blocked_hostname");
  expect(classifyHostnameBlockReason("api.example.com")).toBeUndefined();
});

test("network policy: blocks private and metadata IPs", () => {
  expect(classifyIpBlockReason("127.0.0.1")).toBe("loopback_ip");
  expect(classifyIpBlockReason("0.0.0.0")).toBe("loopback_ip");
  expect(classifyIpBlockReason("0.255.255.255")).toBe("loopback_ip");
  expect(classifyIpBlockReason("10.2.3.4")).toBe("private_ip");
  expect(classifyIpBlockReason("172.20.5.1")).toBe("private_ip");
  expect(classifyIpBlockReason("192.168.1.10")).toBe("private_ip");
  expect(classifyIpBlockReason("169.254.169.254")).toBe("metadata_ip");
  expect(classifyIpBlockReason("8.8.8.8")).toBeUndefined();
});

test("network policy: identifies IP literals", () => {
  expect(isIpLiteral("127.0.0.1")).toBe(true);
  expect(isIpLiteral("::1")).toBe(true);
  expect(isIpLiteral("[::1]")).toBe(true);
  expect(isIpLiteral("api.example.com")).toBe(false);
});

test("network policy: protocol and port checks", () => {
  expect(isAllowedProtocol("http:")).toBe(true);
  expect(isAllowedProtocol("https:")).toBe(true);
  expect(isAllowedProtocol("ftp:")).toBe(false);
  expect(isAllowedPort(443, [80, 443])).toBe(true);
  expect(isAllowedPort(22, [80, 443])).toBe(false);
});

test("network policy: resolves default URL ports", () => {
  expect(resolveUrlPort(new URL("http://example.com/health"))).toBe(80);
  expect(resolveUrlPort(new URL("https://example.com/health"))).toBe(443);
  expect(resolveUrlPort(new URL("https://example.com:8443/health"))).toBe(8443);
});
