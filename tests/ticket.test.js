import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { Ticket } from "../src/models/Ticket.js";
import { generateTicketId } from "../src/controllers/ticket.controller.js";
import { ticketSchemas } from "../src/types/index.js";

const uri = process.env.MONGO_URI_TEST ?? env.mongoUri;
let connected = false;

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  connected = true;
} catch (err) {
  console.log(`[test] MongoDB unavailable (${err?.message ?? err}); Ticket integration tests skipped`);
}

let server;
let base;

before(async () => {
  if (!connected) return;
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (connected) {
    await Ticket.deleteMany({ title: { $regex: /^Test ticket/i } });
    await mongoose.disconnect();
  }
});

async function request(path, { method = "GET", body, headers = {} } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-PharmaHub-Client": "web",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("ticketSchemas Validation (Unit)", () => {
  test("accepts valid ticket creation payload", () => {
    const validData = {
      title: "Barcode scanner not reading batch QR code",
      issueType: "medicines_batches",
      description: "Scanner beeps when scanning Paracetamol 500mg batch PH-2408-01, but no line item is added to the cart.",
      severity: "high",
      screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      userName: "Satya Prakash",
      userEmail: "satya@pharmacy.com",
      userRole: "Pharmacist",
      orgName: "Apollo Pharmacy",
    };
    const result = ticketSchemas.create.safeParse(validData);
    assert.equal(result.success, true);
    assert.equal(result.data.severity, "high");
  });

  test("defaults severity to medium if omitted and accepts omitted screenshot", () => {
    const data = {
      title: "General inquiry on report exports",
      issueType: "reports_export",
      description: "How do we export monthly tax reports to CSV?",
    };
    const result = ticketSchemas.create.safeParse(data);
    assert.equal(result.success, true);
    assert.equal(result.data.severity, "medium");
    assert.equal(result.data.screenshot, undefined);
  });

  test("maps aliases (subject, category, message, priority) and normalizes severity casing", () => {
    const aliasedData = {
      subject: "Help with invoice print format",
      category: "billing_pos",
      message: "The printer paper is getting cut off on the right margin.",
      priority: "HIGH",
    };
    const result = ticketSchemas.create.safeParse(aliasedData);
    assert.equal(result.success, true);
    assert.equal(result.data.title, "Help with invoice print format");
    assert.equal(result.data.issueType, "billing_pos");
    assert.equal(result.data.description, "The printer paper is getting cut off on the right margin.");
    assert.equal(result.data.severity, "high");
  });

  test("rejects empty title or title exceeding max length", () => {
    const empty = ticketSchemas.create.safeParse({
      title: "",
      issueType: "general_inquiry",
      description: "Description is long enough here",
    });
    assert.equal(empty.success, false);

    const long = ticketSchemas.create.safeParse({
      title: "a".repeat(251),
      issueType: "general_inquiry",
      description: "Description is long enough here",
    });
    assert.equal(long.success, false);
  });

  test("rejects empty description or description exceeding max length", () => {
    const empty = ticketSchemas.create.safeParse({
      title: "Valid title",
      issueType: "general_inquiry",
      description: "",
    });
    assert.equal(empty.success, false);

    const long = ticketSchemas.create.safeParse({
      title: "Valid title",
      issueType: "general_inquiry",
      description: "a".repeat(5001),
    });
    assert.equal(long.success, false);
  });

  test("rejects invalid severity value", () => {
    const invalid = ticketSchemas.create.safeParse({
      title: "Valid title",
      issueType: "general_inquiry",
      description: "Valid description here",
      severity: "super-critical",
    });
    assert.equal(invalid.success, false);
  });
});

describe(
  "Support Ticket System (Integration)",
  { skip: !connected && "MongoDB not available - skipped" },
  () => {
    test("generateTicketId produces PH-TKT-YYYY-##### format", async () => {
      const ticketId = await generateTicketId();
      const currentYear = new Date().getFullYear();
      const pattern = new RegExp(`^PH-TKT-${currentYear}-\\d{5}$`);
      assert.match(ticketId, pattern);
    });

    test("validation rejects invalid ticket submissions (missing fields or too short)", async () => {
      // Missing title & description & screenshot
      const res1 = await request("/tickets", {
        method: "POST",
        body: {
          issueType: "billing_pos",
        },
      });
      assert.equal(res1.status, 422);

      // Title too short (< 3 chars)
      const res2 = await request("/tickets", {
        method: "POST",
        body: {
          title: "ab",
          issueType: "billing_pos",
          description: "This is a valid description",
          screenshot: "data:image/png;base64,sample",
        },
      });
      assert.equal(res2.status, 422);

      // Description too short (< 5 chars)
      const res3 = await request("/tickets", {
        method: "POST",
        body: {
          title: "Valid title",
          issueType: "billing_pos",
          description: "1234",
          screenshot: "data:image/png;base64,sample",
        },
      });
      assert.equal(res3.status, 422);

      // Invalid severity enum
      const res4 = await request("/tickets", {
        method: "POST",
        body: {
          title: "Valid title",
          issueType: "billing_pos",
          description: "This is a valid description",
          severity: "ultra-high",
          screenshot: "data:image/png;base64,sample",
        },
      });
      assert.equal(res4.status, 422);
    });

    let createdTicket;
    test("raise ticket with soft-auth fallback successfully", async () => {
      const payload = {
        title: "Test ticket: Barcode scanner not reading batch QR code",
        issueType: "medicines_batches",
        description: "Scanner beeps when scanning Paracetamol 500mg batch PH-2408-01, but no line item is added to the cart.",
        severity: "high",
        screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        userName: "Satya Prakash",
        userEmail: "satya@pharmacy.com",
        userRole: "Pharmacist",
        orgName: "Apollo Pharmacy",
      };

      const res = await request("/tickets", {
        method: "POST",
        body: payload,
      });

      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.message, "Ticket has been raised successfully");
      assert.ok(json.data);
      assert.ok(json.data._id);
      assert.match(json.data.ticketId, /^PH-TKT-\d{4}-\d{5}$/);
      assert.equal(json.data.title, payload.title);
      assert.equal(json.data.issueType, payload.issueType);
      assert.equal(json.data.description, payload.description);
      assert.equal(json.data.severity, "high");
      assert.equal(json.data.status, "open");
      assert.equal(json.data.userName, "Satya Prakash");
      assert.equal(json.data.userEmail, "satya@pharmacy.com");
      assert.equal(json.data.userRole, "Pharmacist");
      assert.equal(json.data.orgName, "Apollo Pharmacy");
      assert.equal(json.data.userId, null);

      createdTicket = json.data;
    });

    test("get ticket by MongoDB _id", async () => {
      assert.ok(createdTicket?._id);
      const res = await request(`/tickets/${createdTicket._id}`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.ticketId, createdTicket.ticketId);
      assert.equal(json.data.title, createdTicket.title);
    });

    test("get ticket by human-readable ticketId", async () => {
      assert.ok(createdTicket?.ticketId);
      const res = await request(`/tickets/${createdTicket.ticketId}`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data._id, createdTicket._id);
      assert.equal(json.data.title, createdTicket.title);
    });

    test("get ticket with unknown ID returns 404", async () => {
      const res = await request("/tickets/PH-TKT-9999-00000");
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.success, false);
    });

    test("list tickets with userEmail filter", async () => {
      const res = await request("/tickets?userEmail=satya@pharmacy.com&status=open&severity=high&page=1&limit=20");
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.message, "Tickets list");
      assert.ok(Array.isArray(json.data));
      assert.ok(json.data.length >= 1);
      assert.ok(json.meta);
      assert.equal(json.meta.page, 1);
      assert.equal(json.meta.limit, 20);
      assert.ok(typeof json.meta.total === "number");
      assert.ok(typeof json.meta.totalPages === "number");

      const match = json.data.find((t) => t.ticketId === createdTicket.ticketId);
      assert.ok(match);
    });

    test("list tickets with search query parameter", async () => {
      const res = await request(`/tickets?userEmail=satya@pharmacy.com&search=${encodeURIComponent(createdTicket.ticketId)}`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.data.some((t) => t.ticketId === createdTicket.ticketId));
    });

    test("update ticket status via PATCH /tickets/:id/status", async () => {
      const res = await request(`/tickets/${createdTicket.ticketId}/status`, {
        method: "PATCH",
        body: { status: "in_progress" },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.equal(json.data.status, "in_progress");

      // Verify persistence
      const verifyRes = await request(`/tickets/${createdTicket._id}`);
      const verifyJson = await verifyRes.json();
      assert.equal(verifyJson.data.status, "in_progress");
    });
  },
);
