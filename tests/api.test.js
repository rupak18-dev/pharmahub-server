import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { Role } from "../src/models/Role.js";
import { User } from "../src/models/User.js";

const uri = process.env.MONGO_URI_TEST ?? env.mongoUri;
let connected = false;
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  connected = true;
} catch (err) {
  console.log(`[test] MongoDB unavailable (${err?.message ?? err}); API flow tests skipped`);
}

let server;
let base;

before(async () => {
  if (!connected) return;
  await Role.ensureSystemRoles();
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

async function request(path, { method = "GET", body, cookie, headers } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // The SPA marks every mutating API call with this custom header; the
      // server's CSRF guard rejects mutations that lack it.
      "X-PharmaHub-Client": "web",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Extracts the session cookie from a login response.
function sessionCookie(res) {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("Expected Set-Cookie on session response");
  assert.ok(/httponly/i.test(raw), "Session cookie must be httpOnly");
  return raw.split(";")[0];
}

describe(
  "full API flow (requires MongoDB)",
  { skip: !connected && "MongoDB not available - skipped" },
  () => {
    const email = `test-${Date.now()}@pharmahub.demo`;
    let cookie;

    test("login with invalid credentials returns 401", async () => {
      const res = await request("/auth/login", {
        method: "POST",
        body: { email: "nobody@example.com", password: "wrongpass" },
      });
      assert.equal(res.status, 401);
    });

    test("register a new user — unverified, no session issued", async () => {
      // Pin the OTP code (6-digit randomInt) so the verify step below can reuse
      // it; all other crypto.randomInt callers (id generation, etc.) fall through
      // to the real implementation.
      const realRandomInt = crypto.randomInt;
      crypto.randomInt = (min, max) =>
        max === 10 ** 6 ? 246810 : realRandomInt(min, max);
      let res;
      try {
        res = await request("/auth/register", {
          method: "POST",
          body: { name: "Integration Tester", email, password: "password123" },
        });
      } finally {
        crypto.randomInt = realRandomInt;
      }
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.data.user.email, email);
      assert.equal(body.data.user.emailVerified, false);
      // The OTP must never be echoed back to the client.
      assert.equal(body.data.devCode, undefined);
      // No auto-login: the account must verify its email before first sign-in.
      assert.equal(res.headers.get("set-cookie"), null);
    });

    test("unverified accounts are blocked at login with email_not_verified", async () => {
      const res = await request("/auth/login", {
        method: "POST",
        body: { email, password: "password123" },
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      // Machine-readable code lets the frontend route to the verify screen
      // instead of showing a generic credentials failure.
      assert.equal(body.error.details.code, "email_not_verified");
    });

    test("verify email marks the account verified", async () => {
      const res = await request("/auth/verify-email", {
        method: "POST",
        body: { email, code: "246810" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.emailVerified, true);
      assert.match(new Date(body.data.emailVerifiedAt).toISOString(), /^\d{4}-/);
    });

    test("login as the new user — session arrives as httpOnly cookie, not in body", async () => {
      const res = await request("/auth/login", {
        method: "POST",
        body: { email, password: "password123" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      // The JWT must never appear in the response body.
      assert.equal(body.data.token, undefined);
      assert.equal(body.data.user.role, "");
      cookie = sessionCookie(res);
    });

    test("get current user via /auth/me using the session cookie", async () => {
      const res = await request("/auth/me", { cookie });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.email, email);
    });

    test("an invalid Authorization header is not ignored when a session cookie exists", async () => {
      // The explicitly-presented token is the identity — a stale cookie must
      // never win over (and silently mask) the credential the client sent.
      const res = await request("/auth/me", {
        cookie,
        headers: { Authorization: "Bearer not.a.valid.token" },
      });
      assert.equal(res.status, 401);
    });

    test("create a category with the session cookie", async () => {
      // Promote the test user to Admin so the category creation is permitted.
      await User.updateOne({ email }, { $set: { role: "Admin" } });
      const res = await request("/categories", {
        method: "POST",
        cookie,
        body: { name: `Cat-${Date.now()}` },
      });
      assert.equal(res.status, 201);
    });

    test("read-only role (Cashier) is denied medicine creation", async () => {
      const cashierEmail = `c-${Date.now()}@pharmahub.demo`;
      const created = await request("/users", {
        method: "POST",
        cookie,
        body: {
          name: "Test Cashier",
          email: cashierEmail,
          password: "password123",
          role: "Cashier",
        },
      });
      assert.equal(created.status, 201);

      const login = await request("/auth/login", {
        method: "POST",
        body: { email: cashierEmail, password: "password123" },
      });
      const cashierCookie = sessionCookie(login);

      const res = await request("/medicines", {
        method: "POST",
        cookie: cashierCookie,
        body: { name: "Should Not Exist" },
      });
      assert.equal(res.status, 403);
    });

    test("list medicines (Pharmacist has view access)", async () => {
      const res = await request("/medicines", { cookie });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(Array.isArray(body.data), true);
    });
  },
);
