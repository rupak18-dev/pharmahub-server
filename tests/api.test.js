import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
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

async function request(path, { method = "GET", body, token } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("full API flow (requires MongoDB)", { skip: !connected && "MongoDB not available - skipped" }, () => {
  const email = `test-${Date.now()}@pharmahub.demo`;

  test("login with invalid credentials returns 401", async () => {
    const res = await request("/auth/login", {
      method: "POST",
      body: { email: "nobody@example.com", password: "wrongpass" },
    });
    assert.equal(res.status, 401);
  });

  test("register a new user", async () => {
    const res = await request("/auth/register", {
      method: "POST",
      body: { name: "Integration Tester", email, password: "password123" },
    });
    assert.equal(res.status, 201);
  });

  let token;
  test("login as the new user", async () => {
    const res = await request("/auth/login", {
      method: "POST",
      body: { email, password: "password123" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    token = body.data.token;
    assert.ok(token);
    assert.equal(body.data.user.role, "Pharmacist");
  });

  test("get current user via /auth/me", async () => {
    const res = await request("/auth/me", { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.email, email);
  });

  test("create a category with the token", async () => {
    // Promote the test user to Admin so the category creation is permitted.
    await User.updateOne({ email }, { $set: { role: "Admin" } });
    const res = await request("/categories", {
      method: "POST",
      token,
      body: { name: `Cat-${Date.now()}` },
    });
    assert.equal(res.status, 201);
  });

  test("read-only role (Cashier) is denied medicine creation", async () => {
    const cashierEmail = `c-${Date.now()}@pharmahub.demo`;
    const created = await request("/users", {
      method: "POST",
      token,
      body: { name: "Test Cashier", email: cashierEmail, password: "password123", role: "Cashier" },
    });
    assert.equal(created.status, 201);

    const login = await request("/auth/login", {
      method: "POST",
      body: { email: cashierEmail, password: "password123" },
    });
    const cashierToken = (await login.json()).data.token;

    const res = await request("/medicines", {
      method: "POST",
      token: cashierToken,
      body: { name: "Should Not Exist" },
    });
    assert.equal(res.status, 403);
  });

  test("list medicines (Pharmacist has view access)", async () => {
    const res = await request("/medicines", { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Array.isArray(body.data), true);
  });
});
