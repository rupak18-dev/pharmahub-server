import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_CLIENT_ID = "google-test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "google-test-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/v1/auth/google/callback";

const { googleAuthUrl } = await import("../src/services/googleAuth.service.js");

describe("googleAuth.service", () => {
  test("googleAuthUrl includes client id, redirect uri, scope and state", () => {
    const url = new URL(googleAuthUrl("my-random-state"));
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "my-random-state");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:5000/api/v1/auth/google/callback");
    assert.equal(url.searchParams.get("client_id"), "google-test-client-id");
    assert.match(url.searchParams.get("scope"), /openid/);
    assert.match(url.searchParams.get("scope"), /email/);
    assert.match(url.searchParams.get("scope"), /profile/);
  });
});
