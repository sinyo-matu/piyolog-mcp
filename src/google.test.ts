import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { googleLoginEnabled, verifyGoogleCode } from "./google.ts";

const CLIENT_ID = "client.apps.googleusercontent.com";
const request = new Request("https://piyo.example/callback/google?code=abc");
const realFetch = globalThis.fetch;

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_ALLOWED_DOMAINS: "example.co.jp",
    ...overrides,
  } as Env;
}

function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `e30.${payload}.sig`;
}

function mockTokenResponse(claims: Record<string, unknown>): void {
  globalThis.fetch = (async () =>
    Response.json({ access_token: "at", id_token: idToken(claims) })) as typeof fetch;
}

const validClaims = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 300,
  email: "Mama@Example.co.jp",
  email_verified: true,
  hd: "example.co.jp",
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("verifyGoogleCode", () => {
  it("accepts a verified account in the allowed Workspace domain", async () => {
    mockTokenResponse(validClaims);
    assert.equal(await verifyGoogleCode(testEnv(), request, "abc"), "mama@example.co.jp");
  });

  it("rejects an address on the domain without the Workspace hd claim", async () => {
    mockTokenResponse({ ...validClaims, hd: undefined });
    assert.equal(await verifyGoogleCode(testEnv(), request, "abc"), null);
  });

  it("rejects another Workspace organization", async () => {
    mockTokenResponse({ ...validClaims, email: "someone@other.example", hd: "other.example" });
    assert.equal(await verifyGoogleCode(testEnv(), request, "abc"), null);
  });

  it("rejects unverified email, wrong audience, wrong issuer and expired tokens", async () => {
    for (const claims of [
      { ...validClaims, email_verified: false },
      { ...validClaims, aud: "other-client" },
      { ...validClaims, iss: "https://evil.example" },
      { ...validClaims, exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      mockTokenResponse(claims);
      assert.equal(await verifyGoogleCode(testEnv(), request, "abc"), null);
    }
  });

  it("rejects when the token exchange fails", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 400 })) as typeof fetch;
    assert.equal(await verifyGoogleCode(testEnv(), request, "abc"), null);
  });
});

describe("googleLoginEnabled", () => {
  it("stays off without any allowed domain or email", () => {
    assert.equal(googleLoginEnabled(testEnv({ GOOGLE_ALLOWED_DOMAINS: " , " })), false);
    assert.equal(googleLoginEnabled(testEnv()), true);
  });
});
