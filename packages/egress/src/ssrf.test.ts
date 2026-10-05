import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivateHostError, assertPublicHost, isPrivateHost, isPrivateIp } from "#egress/ssrf.ts";

describe("isPrivateIp", () => {
  it("rejects private and reserved ipv4 ranges", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      assert.equal(isPrivateIp(address), true, address);
    }
  });

  it("allows public ipv4 addresses", () => {
    for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.128.0.1", "1.1.1.1"]) {
      assert.equal(isPrivateIp(address), false, address);
    }
  });

  it("rejects private ipv6 ranges", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "::ffff:7f00:1"]) {
      assert.equal(isPrivateIp(address), true, address);
    }
  });

  it("allows public ipv6 addresses", () => {
    assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
    assert.equal(isPrivateIp("2001:db8:0:0:0:0:0:1"), false);
  });

  it("treats invalid input as private", () => {
    assert.equal(isPrivateIp("example.com"), true);
    assert.equal(isPrivateIp("999.1.1.1"), true);
  });
});

describe("isPrivateHost", () => {
  it("blocks local hostnames", () => {
    for (const host of ["localhost", "foo.localhost", "printer.local", "api.internal", "  LOCALHOST  ", ""]) {
      assert.equal(isPrivateHost(host), true, host);
    }
  });

  it("handles bracketed and ip literals", () => {
    assert.equal(isPrivateHost("[::1]"), true);
    assert.equal(isPrivateHost("127.0.0.1"), true);
    assert.equal(isPrivateHost("8.8.8.8"), false);
    assert.equal(isPrivateHost("example.com"), false);
  });
});

describe("assertPublicHost", () => {
  it("throws for private hosts", () => {
    assert.throws(() => assertPublicHost("127.0.0.1"), PrivateHostError);
  });

  it("allows public hosts", () => {
    assert.doesNotThrow(() => assertPublicHost("example.com"));
  });
});
