import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { Role } from "../src/models/Role.js";
import { User } from "../src/models/User.js";
import { Batch } from "../src/models/Batch.js";

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

  test("register rejects a weak password", async () => {
    const res = await request("/auth/register", {
      method: "POST",
      body: { email: `weak-${Date.now()}@pharmahub.demo`, password: "password123" },
    });
    assert.equal(res.status, 422);
  });

  test("register a new user", async () => {
    const res = await request("/auth/register", {
      method: "POST",
      body: { name: "Integration Tester", email, password: "Password123!" },
    });
    assert.equal(res.status, 201);
  });

  let token;
  test("login as the new user", async () => {
    const res = await request("/auth/login", {
      method: "POST",
      body: { email, password: "Password123!" },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /pharmahub_session=/);
    assert.match(setCookie, /HttpOnly/);
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

  test("logout clears the session cookie", async () => {
    const res = await request("/auth/logout", { method: "POST" });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /pharmahub_session=/);
    assert.match(setCookie, /expires=Thu, 01 Jan 1970/i);
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
      body: { name: "Test Cashier", email: cashierEmail, password: "Password123!", role: "Cashier" },
    });
    assert.equal(created.status, 201);

    const login = await request("/auth/login", {
      method: "POST",
      body: { email: cashierEmail, password: "Password123!" },
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

  let batchId;
  let batchMedicineId;
  test("create a medicine to attach the batch to", async () => {
    const res = await request("/medicines", {
      method: "POST",
      token,
      body: { name: `Batch Test Med ${Date.now()}` },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    batchMedicineId = String(body.data._id);
  });

  test("create a batch with the nested payload", async () => {
    const res = await request("/batches", {
      method: "POST",
      token,
      body: {
        medicineId: batchMedicineId,
        batchNumber: `FS-26-C-${Date.now().toString().slice(-4)}`,
        batchType: "C",
        dates: {
          manufacturingDate: "2026-01-01T00:00:00.000Z",
          expiryDate: "2028-01-01T00:00:00.000Z",
        },
        pricing: { purchasePrice: 10, mrp: 15, sellingPrice: 14, gstRate: 12 },
        status: { isRecalled: false, state: "ACTIVE" },
        stock: { uom: "Units", quantityOnHand: 100, reservedQuantity: 0, quarantined: 0 },
        warehouse: { locationType: "Front Shelf", rackCode: "A-1" },
      },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    batchId = body.data.id;
    assert.ok(batchId);
    assert.equal(body.data.status.state, "ACTIVE");
    assert.equal(body.data.stock.quantityOnHand, 100);
    assert.equal(body.data.pricing.mrp, 15);
    assert.equal(body.data.warehouse.locationType, "Front Shelf");
    assert.equal(body.data.medicineId, batchMedicineId);
  });

  test("duplicate batch number returns a friendly 409", async () => {
    const batch = await Batch.findOne({ _id: batchId }).lean();
    const res = await request("/batches", {
      method: "POST",
      token,
      body: {
        medicineId: batchMedicineId,
        batchNumber: batch.batchNumber,
        dates: {
          manufacturingDate: "2026-01-01T00:00:00.000Z",
          expiryDate: "2028-01-01T00:00:00.000Z",
        },
        warehouse: { locationType: "Front Shelf", rackCode: "B-2" },
      },
    });
    assert.equal(res.status, 409);
  });

  test("list batches returns serialized nested docs with a plain medicineId", async () => {
    const res = await request("/batches", { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    const found = body.data.find((b) => b.id === batchId);
    assert.ok(found);
    assert.equal(found.medicineId, batchMedicineId);
    assert.equal(found.status.state, "ACTIVE");
  });

  test("quarantine action moves stock into quarantine", async () => {
    const res = await request(`/batches/${batchId}`, {
      method: "PATCH",
      token,
      body: { action: "quarantine", reason: "QC hold" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status.state, "QUARANTINED");
    assert.equal(body.data.stock.quantityOnHand, 0);
    assert.equal(body.data.stock.quarantined, 100);
    assert.ok(body.data.dates.quarantineUntil);
    assert.ok(body.data.version >= 2);
  });

  test("get batch detail returns nested fields plus locations", async () => {
    const res = await request(`/batches/${batchId}`, { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.id, batchId);
    assert.equal(body.data.status.state, "QUARANTINED");
    assert.ok(Array.isArray(body.data.locations));
  });

  test("delete a batch with no stock on hand", async () => {
    const res = await request(`/batches/${batchId}`, { method: "DELETE", token });
    assert.equal(res.status, 204);
  });
});
