import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  isAcceptablePassword,
  verifyPassword,
} from "@/lib/password";

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("Correct horse battery", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).not.toContain("correct horse battery");
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("correct horse battery"),
      hashPassword("correct horse battery"),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", b)).toBe(true);
  });

  it("treats a malformed stored hash as a failed check, not a crash", async () => {
    expect(await verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });
});

describe("password policy", () => {
  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(isAcceptablePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isAcceptablePassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isAcceptablePassword(undefined)).toBe(false);
    expect(isAcceptablePassword(null)).toBe(false);
    expect(isAcceptablePassword(12345678)).toBe(false);
  });

  it("refuses to hash a password that fails the policy", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
});
