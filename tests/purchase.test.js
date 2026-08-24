import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { Role } from "../src/models/Role.js";
import { Supplier } from "../src/models/Supplier.js";
import { Medicine } from "../src/models/Medicine.js";
import { Category } from "../src/models/Category.js";
import { Batch } from "../src/models/Batch.js";
import { sweepExpiredBatches } from "../src/services/inventory.service.js";

const uri = process.env.MONGO_URI_TEST ?? env.mongoUri;
let connected = false;
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  connected = true;
} catch (err) {
  console.log(`[test] MongoDB unavailable (${err?.message ?? err}); Purchase tests skipped`);
}

let server;
let base;
let token;
let supplierId;
let medicineId;

before(async () => {
  if (!connected) return;
  await Role.ensureSystemRoles();
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Create admin user and token
  const email = `purchaser-${Date.now()}@pharmahub.demo`;
  await request("/auth/register", {
    method: "POST",
    body: { name: "Purchasing Manager", email, password: "Password123!", role: "Admin" },
  });
  const loginRes = await request("/auth/login", {
    method: "POST",
    body: { email, password: "Password123!" },
  });
  const loginData = await loginRes.json();
  token = loginData.data?.token;

  // Elevate user role to Owner
  await request("/auth/profile", {
    method: "PUT",
    body: { role: "Owner" },
  });

  // Create category, medicine, and supplier
  let cat = await Category.findOne({ name: "Analgesics" });
  if (!cat) cat = await Category.create({ name: "Analgesics" });

  let sup = await Supplier.findOne({ name: "MedSupply Co." });
  if (!sup) sup = await Supplier.create({ name: "MedSupply Co.", contactInfo: "orders@medsupply.com" });
  supplierId = String(sup._id);

  let med = await Medicine.findOne({ name: "Paracetamol 500mg" });
  if (!med) {
    med = await Medicine.create({
      name: "Paracetamol 500mg",
      genericName: "Paracetamol",
      categoryId: cat._id,
      reorderThreshold: 10,
      gstRate: 12,
    });
  }
  medicineId = String(med._id);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

async function request(path, { method = "GET", body } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Purchase & Bill Management API flow (MongoDB)", { skip: !connected && "MongoDB not available - skipped" }, () => {
  const invoiceNumber = `INV-${Date.now()}`;
  const batchNum = `BTH-${Date.now()}`;
  let createdPurchaseId;

  test("create a direct purchase bill with line items and stock update", async () => {
    const res = await request("/purchases", {
      method: "POST",
      body: {
        supplierId,
        invoiceNumber,
        invoiceDate: new Date().toISOString(),
        paymentType: "upi",
        paymentStatus: "paid",
        amountPaid: 1120,
        paymentTxnRef: "UPI-REF-998877",
        items: [
          {
            medicineId,
            medicineName: "Paracetamol 500mg",
            batchNumber: batchNum,
            mfgDate: "2026-01-01",
            expiryDate: "2027-12-31",
            mrp: 150,
            ptr: 100,
            unitCost: 100,
            quantity: 10,
            freeQty: 2,
            schemeAmt: 0,
            discPct: 0,
            gstRate: 12,
          },
        ],
      },
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.invoiceNumber, invoiceNumber);
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].batchNumber, batchNum);
    createdPurchaseId = body.data._id;

    // Verify batch was created in MongoDB with updated stock (10 + 2 = 12)
    const batch = await Batch.findOne({ medicineId, batchNumber: batchNum });
    assert.ok(batch, "Batch should exist in MongoDB");
    assert.equal(batch.stock.quantityOnHand, 12);
    assert.equal(batch.pricing.purchasePrice, 100);
    assert.equal(batch.pricing.mrp, 150);
  });

  test("get purchase by ID", async () => {
    const res = await request(`/purchases/${createdPurchaseId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data._id, createdPurchaseId);
    assert.equal(body.data.invoiceNumber, invoiceNumber);
  });

  test("lookup purchase by invoice number (Fetch Bill feature)", async () => {
    const res = await request(`/purchases/${invoiceNumber}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data._id, createdPurchaseId);
    assert.equal(body.data.invoiceNumber, invoiceNumber);
  });

  test("list purchases with filter and search", async () => {
    const res = await request(`/purchases?search=${invoiceNumber}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 1);
    assert.equal(body.data[0].invoiceNumber, invoiceNumber);
  });

  test("purchase increases the medicine-level global stock", async () => {
    const med = await Medicine.findById(medicineId).lean();
    const batches = await Batch.find({ medicineId }).lean();
    const sellableQty = batches
      .filter((b) => b.status?.state === "ACTIVE" && new Date(b.dates?.expiryDate).getTime() > Date.now())
      .reduce((s, b) => s + (b.stock?.quantityOnHand ?? 0), 0);
    assert.equal(med.totalStock, sellableQty, "medicine.totalStock should equal sum of sellable batch quantities");
    assert.ok(med.totalStock >= 12, "should include the 12 units received from the purchase");
  });

  test("selling medicine decreases global medicine stock", async () => {
    const before = (await Medicine.findById(medicineId).lean()).totalStock;
    const res = await request("/sales", {
      method: "POST",
      body: { items: [{ medicineId, quantity: 3 }], paymentMode: "Cash" },
    });
    assert.equal(res.status, 201);
    const after = (await Medicine.findById(medicineId).lean()).totalStock;
    assert.equal(before - after, 3, "sale of 3 units should reduce medicine.totalStock by 3");
  });

  test("dashboard reports revenue, cost, profit and purchase spend", async () => {
    const res = await request("/dashboard/stats");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.data.today.profit, "number");
    assert.equal(typeof body.data.week.cost, "number");
    assert.equal(typeof body.data.purchases.spendWeek, "number");
    assert.equal(body.data.week.profit, Math.round((body.data.week.sales - body.data.week.cost) * 100) / 100);
  });

  test("expiry sweep retires expired batches and removes them from sellable stock", async () => {
    // Create an expired ACTIVE batch with stock directly in MongoDB.
    const expiredBatch = await Batch.create({
      medicineId,
      batchNumber: `EXP-${Date.now()}`,
      dates: { manufacturingDate: new Date("2024-01-01"), expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      pricing: { purchasePrice: 10, mrp: 20, sellingPrice: 18, gstRate: 12 },
      stock: { uom: "Units", quantityOnHand: 7 },
    });
    const before = (await Medicine.findById(medicineId).lean()).totalStock;

    const result = await sweepExpiredBatches({ force: true });
    assert.ok(result.retired >= 1);

    const updated = await Batch.findById(expiredBatch._id).lean();
    assert.equal(updated.status.state, "RETIRED");

    const after = (await Medicine.findById(medicineId).lean()).totalStock;
    assert.equal(before - after, 7, "expired quantity must be written off the global total");
  });
});
