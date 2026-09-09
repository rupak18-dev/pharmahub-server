import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { User } from "../src/models/User.js";
import { Invitation } from "../src/models/Invitation.js";
import {
  inviteUser,
  listInvitations,
  getInvitation,
  acceptInvitation,
  listUsers,
} from "../src/controllers/user.controller.js";

const uri = process.env.MONGO_URI_TEST ?? env.mongoUri;
let connected = false;
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  connected = true;
} catch (err) {
  console.log(`[test] MongoDB unavailable (${err?.message ?? err}); invitation tests skipped`);
}

test(
  "End-to-End Staff Invitation Flow",
  { skip: !connected && "MongoDB not available - skipped" },
  async (t) => {

  const owner = await User.findOne({ role: "Owner" });
  assert.ok(owner, "Expected at least one Owner in the database");

  const testEmail = `test.staff.${Date.now()}@example.com`;
  const invitePayload = {
    name: "Integration Test Staff",
    email: testEmail,
    role: "Pharmacist",
    accessIds: ["medicines", "sales", "expiry"],
    permissions: {},
    featureAccess: { processSales: true },
  };

  let createdInvId = null;
  let rawToken = null;

  await t.test("1. inviteUser creates pending invitation & attempts email", async () => {
    let resData = null;
    let resCode = 200;
    const req = {
      user: owner,
      body: invitePayload,
      ip: "127.0.0.1",
    };
    const res = {
      status(code) {
        resCode = code;
        return this;
      },
      json(data) {
        resData = data;
        return this;
      },
    };

    await inviteUser(req, res);
    assert.equal(resCode, 201);
    assert.equal(resData.success, true);
    assert.ok(resData.data.id, "Expected invitation ID");
    assert.equal(resData.data.email, testEmail);
    assert.equal(resData.data.status, "pending");

    createdInvId = resData.data.id;
    if (resData.data.link) {
      const match = resData.data.link.match(/token=([a-f0-9]+)/);
      if (match) rawToken = match[1];
    }

    const doc = await Invitation.findById(createdInvId);
    assert.ok(doc, "Invitation document must exist in MongoDB");
    assert.equal(doc.status, "pending");
  });

  await t.test("2. listInvitations includes the new pending invitation", async () => {
    let resData = null;
    const req = {
      user: owner,
      query: {},
    };
    const res = {
      status() {
        return this;
      },
      json(data) {
        resData = data;
        return this;
      },
    };

    await listInvitations(req, res);
    assert.equal(resData.success, true);
    assert.ok(Array.isArray(resData.data));
    const found = resData.data.find((i) => i.id === createdInvId || i.email === testEmail);
    assert.ok(found, "Expected newly invited staff to appear in listInvitations");
    assert.equal(found.status, "pending");
  });

  await t.test("3. getInvitation validates the raw token publicly", async () => {
    assert.ok(rawToken, "Expected raw token from step 1");
    let resData = null;
    const req = {
      params: { token: rawToken },
    };
    const res = {
      status() {
        return this;
      },
      json(data) {
        resData = data;
        return this;
      },
    };

    await getInvitation(req, res);
    assert.equal(resData.success, true);
    assert.equal(resData.data.valid, true);
    assert.equal(resData.data.email, testEmail);
    assert.equal(resData.data.role, "Pharmacist");
  });

  await t.test("4. acceptInvitation activates account & updates status to active", async () => {
    assert.ok(rawToken, "Expected raw token");
    let resData = null;
    let resCode = 200;
    const req = {
      body: {
        token: rawToken,
        name: "Integration Test Staff",
        password: "Password@123",
      },
      ip: "127.0.0.1",
    };
    const res = {
      status(code) {
        resCode = code;
        return this;
      },
      json(data) {
        resData = data;
        return this;
      },
    };

    await acceptInvitation(req, res);
    assert.equal(resCode, 201);
    assert.equal(resData.success, true);
    assert.ok(resData.data.token, "Expected issued auth token");
    assert.equal(resData.data.user.email, testEmail);
    assert.equal(resData.data.user.active, true);

    const userDoc = await User.findOne({ email: testEmail });
    assert.ok(userDoc, "User document must exist in MongoDB");
    assert.equal(userDoc.status, "active");

    const invDoc = await Invitation.findById(createdInvId);
    assert.equal(invDoc.status, "accepted");
  });

  await t.test("5. listUsers includes the accepted staff member as active", async () => {
    let resData = null;
    const req = {
      user: owner,
      query: {},
    };
    const res = {
      status() {
        return this;
      },
      json(data) {
        resData = data;
        return this;
      },
    };

    await listUsers(req, res);
    assert.equal(resData.success, true);
    const found = resData.data.find((u) => u.email === testEmail);
    assert.ok(found, "Expected activated user in listUsers");
    assert.equal(found.active, true);
  });

  // Cleanup test artifacts from DB
  await User.deleteOne({ email: testEmail });
  await Invitation.deleteOne({ email: testEmail });
  await mongoose.disconnect();
  },
);
