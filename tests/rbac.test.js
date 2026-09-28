import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { Role } from "../src/models/Role.js";
import { User } from "../src/models/User.js";
import { Invitation } from "../src/models/Invitation.js";

const uri = process.env.MONGO_URI_TEST ?? env.mongoUri;
let connected = false;
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
  connected = true;
} catch (err) {
  console.log(`[test] MongoDB unavailable (${err?.message ?? err}); RBAC escalation tests skipped`);
}

let server;
let base;
let createdUserIds = [];
let createdInvitationIds = [];

before(async () => {
  if (!connected) return;
  // System roles are seeded at boot; the tests below resolve real role records,
  // so make sure they exist first.
  await Role.ensureSystemRoles();
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (connected) {
    if (createdInvitationIds.length > 0) {
      await Invitation.deleteMany({ _id: { $in: createdInvitationIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    await mongoose.disconnect();
  }
});

async function request(path, { method = "GET", body, token, headers = {} } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-PharmaHub-Client": "web",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createTestUser({ name, email, role = "", orgName = "" }) {
  const user = await User.create({
    name,
    email,
    role,
    orgName,
    emailVerified: true,
    status: "active",
  });
  createdUserIds.push(user._id);
  return user;
}

describe(
  "privilege-escalation guards (requires MongoDB)",
  { skip: !connected && "MongoDB not available - skipped" },
  () => {
    const stamp = Date.now();
    let roleLessToken;
    let pharmacistToken;
    let adminToken;
    let ownerToken;
    let roleLessUser;
    let pendingInvitationId;

    test("create fixture users for each role", async () => {
      const { issueToken } = await import("../src/services/auth.service.js");

      roleLessUser = await createTestUser({
        name: "Role-less Self-Registrant",
        email: `roleless-${stamp}@pharmahub.demo`,
      });
      roleLessToken = issueToken(roleLessUser._id);

      const pharmacist = await createTestUser({
        name: "Fixture Pharmacist",
        email: `pharmacist-${stamp}@pharmahub.demo`,
        role: "Pharmacist",
        orgName: `Org ${stamp}`,
      });
      pharmacistToken = issueToken(pharmacist._id);

      const admin = await createTestUser({
        name: "Fixture Admin",
        email: `admin-${stamp}@pharmahub.demo`,
        role: "Admin",
        orgName: `Org ${stamp}`,
      });
      adminToken = issueToken(admin._id);

      const owner = await createTestUser({
        name: "Fixture Owner",
        email: `owner-${stamp}@pharmahub.demo`,
        role: "Owner",
        orgName: `Org ${stamp}`,
      });
      ownerToken = issueToken(owner._id);

      assert.ok(roleLessToken && pharmacistToken && adminToken && ownerToken);
    });

    // ── Onboarding role adoption ────────────────────────────────────────────
    // The wizard has no validation middleware and takes `personal.jobTitle`
    // straight from the body, then writes it onto the user as `role`. Role
    // names are matched by string in authorize(), so adopting "Owner" granted
    // unrestricted access to every module.

    test("onboarding cannot escalate a role-less account to Owner", async () => {
      assert.equal(roleLessUser.role, "", "fixture must start role-less");

      const res = await request("/onboarding", {
        method: "PUT",
        token: roleLessToken,
        body: {
          onboarded: true,
          personal: { jobTitle: "Owner", firstName: "Esca", lastName: "Lator" },
          workspace: { organizationName: `Escalated Org ${stamp}` },
        },
      });
      assert.equal(res.status, 200);

      const after1 = await User.findById(roleLessUser._id).lean();
      assert.notEqual(after1.role, "Owner");
      assert.equal(after1.role, "");
      // The rest of the wizard must still take effect — this is a scoped
      // guard on the role field, not a rejection of the whole request.
      assert.equal(after1.onboarded, true);
      assert.equal(after1.orgName, `Escalated Org ${stamp}`);
    });

    test("onboarding cannot escalate a role-less account to Admin", async () => {
      const res = await request("/onboarding", {
        method: "PUT",
        token: roleLessToken,
        body: {
          onboarded: true,
          personal: { jobTitle: "Admin" },
        },
      });
      assert.equal(res.status, 200);

      const after1 = await User.findById(roleLessUser._id).lean();
      assert.notEqual(after1.role, "Admin");
    });

    test("onboarding still adopts a legitimate staff role from the job title", async () => {
      const user = await createTestUser({
        name: "Wizard Pharmacist",
        email: `wizard-${stamp}@pharmahub.demo`,
      });
      const { issueToken } = await import("../src/services/auth.service.js");
      const token = issueToken(user._id);

      const res = await request("/onboarding", {
        method: "PUT",
        token,
        body: {
          onboarded: true,
          personal: { jobTitle: "Pharmacist", firstName: "Wiz", lastName: "Ard" },
        },
      });
      assert.equal(res.status, 200);

      const after1 = await User.findById(user._id).lean();
      assert.equal(after1.role, "Pharmacist");
      assert.ok(after1.roleId, "the Role record must be linked");
    });

    test("onboarding will not downgrade an already-assigned role", async () => {
      const res = await request("/onboarding", {
        method: "PUT",
        token: pharmacistToken,
        body: {
          onboarded: true,
          personal: { jobTitle: "Owner" },
        },
      });
      assert.equal(res.status, 200);

      const after1 = await User.findOne({ email: `pharmacist-${stamp}@pharmahub.demo` }).lean();
      assert.equal(after1.role, "Pharmacist");
    });

    // ── Invitation role assignment ──────────────────────────────────────────
    // createUser already refused a non-Owner creating an Owner. The invite
    // paths reached the same write with no equivalent check, and
    // acceptInvitation then stamps the role onto the real account.

    test("an Admin cannot invite a user as Owner", async () => {
      const res = await request("/users/invite", {
        method: "POST",
        token: adminToken,
        body: {
          email: `sneaky-${stamp}@example.com`,
          name: "Sneaky Admin",
          role: "Owner",
        },
      });
      assert.equal(res.status, 403);
      assert.equal(await Invitation.countDocuments({ email: `sneaky-${stamp}@example.com` }), 0);
    });

    test("a Pharmacist cannot invite a user as Owner", async () => {
      const res = await request("/users/invite", {
        method: "POST",
        token: pharmacistToken,
        body: {
          email: `sneaky2-${stamp}@example.com`,
          name: "Sneaky Pharmacist",
          role: "Owner",
        },
      });
      assert.equal(res.status, 403);
    });

    test("the Owner can still invite a user as Owner", async () => {
      const res = await request("/users/invite", {
        method: "POST",
        token: ownerToken,
        body: {
          email: `legit-owner-${stamp}@example.com`,
          name: "Legit Second Owner",
          role: "Owner",
        },
      });
      assert.equal(res.status, 201);
      const json = await res.json();
      createdInvitationIds.push(json.data.id);
      assert.equal(json.data.role, "Owner");
    });

    test("a non-Owner cannot promote a pending invitation to Owner", async () => {
      const res = await request("/users/invite", {
        method: "POST",
        token: adminToken,
        body: {
          email: `promote-${stamp}@example.com`,
          name: "Pending Staff",
          role: "Cashier",
        },
      });
      assert.equal(res.status, 201);
      const json = await res.json();
      createdInvitationIds.push(json.data.id);
      pendingInvitationId = json.data.id;

      const patch = await request(`/users/${pendingInvitationId}`, {
        method: "PATCH",
        token: adminToken,
        body: { role: "Owner" },
      });
      assert.equal(patch.status, 403);

      const stillPending = await Invitation.findById(pendingInvitationId).lean();
      assert.equal(stillPending.role, "Cashier");
    });

    // ── inventory / notifications module resolution ──────────────────────────
    // Both modules were guarded by authorize() but absent from
    // constants.modules, which is what builds the permission matrix — so the
    // lookup returned undefined and every one of these endpoints was 403 for
    // every non-Owner.

    test("inventory and notifications are resolvable permission modules", async () => {
      const { constants } = await import("../src/config/constants.js");
      const { DEFAULT_ROLE_PERMISSIONS } = await import("../src/models/Role.js");

      for (const mod of ["inventory", "notifications"]) {
        assert.ok(constants.modules.includes(mod), `${mod} must be in constants.modules`);
        assert.ok(
          constants.accessModules.includes(mod),
          `${mod} must be in constants.accessModules`,
        );
        for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
          assert.ok(perms[mod], `${role} defaults must include ${mod}`);
        }
      }
    });

    test("system role records carry an entry for every permission module", async () => {
      // Note this asserts presence, not the granted values. Records seeded
      // before a module was (re)introduced can legitimately hold an
      // all-false entry, which is an intentional-deny state and is repaired
      // by editing the role, not by clobbering it at boot.
      const { constants } = await import("../src/config/constants.js");
      for (const role of await Role.find({ isSystem: true }).lean()) {
        const perms =
          role.permissions instanceof Map
            ? Object.fromEntries(role.permissions)
            : role.permissions;
        for (const mod of constants.modules) {
          assert.ok(perms[mod], `${role.name} must have an entry for ${mod}`);
        }
      }
    });

    test("a Pharmacist can read notifications (previously always 403)", async () => {
      const res = await request("/notifications", { token: pharmacistToken });
      assert.equal(res.status, 200);
    });

    test("a Cashier is still denied inventory access", async () => {
      const cashier = await createTestUser({
        name: "Fixture Cashier",
        email: `cashier-${stamp}@pharmahub.demo`,
        role: "Cashier",
      });
      const { issueToken } = await import("../src/services/auth.service.js");
      const token = issueToken(cashier._id);

      // A Cashier has no inventory rights under the default matrix, and the
      // stored role record agrees — the module being *resolvable* must not turn
      // into a blanket grant.
      assert.equal((await request("/inventory", { token })).status, 403);
      assert.equal(
        (
          await request("/inventory/adjust", {
            method: "POST",
            token,
            body: { batchId: "000000000000000000000000", delta: 1, reason: "nope" },
          })
        ).status,
        403,
      );
    });

    test("an Inventory Manager can view inventory", async () => {
      const manager = await createTestUser({
        name: "Fixture Inventory Manager",
        email: `invmgr-${stamp}@pharmahub.demo`,
        role: "Inventory Manager",
      });
      const { issueToken } = await import("../src/services/auth.service.js");
      const token = issueToken(manager._id);

      const res = await request("/inventory", { token });
      assert.equal(res.status, 200);
    });

    // The durable guard for this bug class: `authorize()` resolves a module by
    // looking it up in the permission matrix, and that matrix is built from
    // `constants.modules`. A route guarding on a module missing from that list
    // resolves undefined and throws 403 for every non-Owner, with no test
    // failing anywhere. This catches the next one at build time.

    test("every module guarded by a route exists in the permission matrix", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { constants } = await import("../src/config/constants.js");

      const routesDir = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "routes",
      );

      const unguarded = [];
      for (const file of fs.readdirSync(routesDir)) {
        if (!file.endsWith(".routes.js")) continue;
        const source = fs.readFileSync(path.join(routesDir, file), "utf8");
        for (const match of source.matchAll(/authorize\(\s*["'`]([^"'`]+)["'`]/g)) {
          if (!constants.modules.includes(match[1])) {
            unguarded.push(`${file}: ${match[1]}`);
          }
        }
      }

      assert.deepEqual(
        unguarded,
        [],
        `authorize() called with modules absent from constants.modules: ${unguarded.join(", ")}`,
      );
    });
  },
);
