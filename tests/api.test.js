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

describe(
  "full API flow (requires MongoDB)",
  { skip: !connected && "MongoDB not available - skipped" },
  () => {
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
      // Self-registered accounts are intentionally role-less until onboarding
      // (job title) or an Owner assigns one — never a silent default.
      assert.equal(body.data.user.role, "");
    });

    test("onboarding completion persists selected job title as the account role", async () => {
      const ownerEmail = `wizard-owner-${Date.now()}@pharmahub.demo`;
      await request("/auth/register", {
        method: "POST",
        body: { name: "Wizard Owner", email: ownerEmail, password: "password123" },
      });
      const login = await request("/auth/login", {
        method: "POST",
        body: { email: ownerEmail, password: "password123" },
      });
      const wizardToken = (await login.json()).data.token;

      const save = await request("/onboarding", {
        method: "PUT",
        token: wizardToken,
        body: {
          personal: { firstName: "Wizard", lastName: "Owner", jobTitle: "Owner" },
          workspace: { organizationName: `Wizard Org ${Date.now()}`, branchName: "HQ" },
          onboarded: true,
          completedAt: new Date().toISOString(),
        },
      });
      assert.equal(save.status, 200);

      // Role must be live on /auth/me immediately — no re-login required.
      const me = await request("/auth/me", { token: wizardToken });
      assert.equal(me.status, 200);
      const body = await me.json();
      assert.equal(body.data.role, "Owner");
      assert.equal(body.data.onboarded, true);
      assert.ok(body.data.orgName?.startsWith("Wizard Org"));
      // Owner role defaults resolve into effective permissions.
      assert.equal(body.data.permissions?.dashboard?.view, true);
      assert.equal(body.data.permissions?.users?.create, true);
      // roleId links to the seeded system Owner record.
      const dbUser = await User.findOne({ email: ownerEmail }).lean();
      assert.ok(dbUser.roleId, "roleId should reference the system Owner record");
    });

    test("second user selecting Pharmacist keeps roles isolated", async () => {
      const pharmEmail = `wizard-pharmacist-${Date.now()}@pharmahub.demo`;
      await request("/auth/register", {
        method: "POST",
        body: { name: "Wizard Pharmacist", email: pharmEmail, password: "password123" },
      });
      const login = await request("/auth/login", {
        method: "POST",
        body: { email: pharmEmail, password: "password123" },
      });
      const pharmacistToken = (await login.json()).data.token;

      const save = await request("/onboarding", {
        method: "PUT",
        token: pharmacistToken,
        body: {
          personal: { firstName: "Wiz", lastName: "Pharm", jobTitle: "Pharmacist" },
          workspace: { organizationName: "Other Org", branchName: "HQ" },
          onboarded: true,
          completedAt: new Date().toISOString(),
        },
      });
      assert.equal(save.status, 200);

      const me = await request("/auth/me", { token: pharmacistToken });
      const body = await me.json();
      assert.equal(body.data.role, "Pharmacist");
      // Pharmacist defaults: can view dashboard but never manage users.
      assert.equal(body.data.permissions?.dashboard?.view, true);
      assert.equal(body.data.permissions?.users?.create, false);
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
  },
);
