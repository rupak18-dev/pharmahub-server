import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const actionDefaults = Object.fromEntries(constants.actions.map((a) => [a, false]));
const emptyModulePermissions = Object.fromEntries(
  constants.modules.map((m) => [m, actionDefaults]),
);

const all = () => ({
  view: true,
  create: true,
  update: true,
  delete: true,
  approve: true,
  export: true,
});
const none = () => ({ ...actionDefaults });
const view = () => ({ ...actionDefaults, view: true });
const viewExport = () => ({ ...view(), export: true });

function rolePermissions(fn) {
  return Object.fromEntries(constants.modules.map((m) => [m, fn(m)]));
}

export const DEFAULT_ROLE_PERMISSIONS = {
  Owner: rolePermissions(() => all()),
  Admin: rolePermissions(() => all()),
  Pharmacist: rolePermissions((m) => {
    if (m === "sales") return { ...all(), delete: false, approve: false };
    if (["medicines", "batches", "expiry"].includes(m)) return { ...viewExport(), update: true };
    if (["dashboard", "reports"].includes(m)) return viewExport();
    return view();
  }),
  Cashier: rolePermissions((m) => {
    if (m === "sales") return { ...none(), view: true, create: true };
    if (["dashboard", "medicines", "batches", "shortbook"].includes(m)) return view();
    return none();
  }),
  "Store Keeper": rolePermissions((m) => {
    if (m === "batches") return { ...view(), create: true, update: true };
    if (["dashboard", "medicines", "expiry", "audit", "shortbook"].includes(m)) return view();
    return none();
  }),
  "Inventory Manager": rolePermissions((m) => {
    if (["medicines", "batches", "expiry", "audit", "purchases"].includes(m))
      return { ...all(), delete: m === "batches" };
    if (["dashboard", "reports"].includes(m)) return viewExport();
    return view();
  }),
};

// Human-readable copy shown in the UI, keyed by the canonical role names.
// Seeded into system role records on creation (and only when missing) so the
// roles list never needs to fall back to a hardcoded frontend catalog.
export const DEFAULT_ROLE_META = {
  Owner: {
    description:
      "Full unrestricted access to every module and setting. The Owner manages the pharmacy, staff and all business data.",
    department: "Management",
  },
  Admin: {
    description:
      "Operational administrator with access to staff management, reports and all core modules.",
    department: "Administration",
  },
  Pharmacist: {
    description:
      "Runs day-to-day pharmacy operations: dispensing sales, managing medicines, batches and expiry tracking.",
    department: "Operations",
  },
  Cashier: {
    description:
      "Handles the sales counter: ringing up sales and looking up medicines and batches.",
    department: "Billing",
  },
  "Store Keeper": {
    description:
      "Manages the store: receiving and stocking inventory, tracking batches and expiry of stocked items.",
    department: "Inventory",
  },
  "Inventory Manager": {
    description:
      "Owns the inventory pipeline: purchases, batches, expiry tracking and audit of stock movements.",
    department: "Inventory",
  },
};

const roleSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, trim: true, default: "" },
    department: { type: String, trim: true, default: "" },
    active: { type: Boolean, default: true },
    permissions: {
      type: Map,
      of: new Schema(
        {
          view: { type: Boolean, default: false },
          create: { type: Boolean, default: false },
          update: { type: Boolean, default: false },
          delete: { type: Boolean, default: false },
          approve: { type: Boolean, default: false },
          export: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: emptyModulePermissions,
    },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);

roleSchema.statics.ensureSystemRoles = async function () {
  const RoleModel = this;
  const existing = await RoleModel.find({ isSystem: true }).select("name permissions").lean();
  const existingNames = new Set(existing.map((r) => r.name));
  const created = [];
  for (const name of constants.roles) {
    const defaults = DEFAULT_ROLE_PERMISSIONS[name] ?? emptyModulePermissions;
    const meta = DEFAULT_ROLE_META[name] ?? {};
    if (!existingNames.has(name)) {
      await RoleModel.create({
        name,
        permissions: defaults,
        description: meta.description ?? "",
        department: meta.department ?? "",
        isSystem: true,
      });
      created.push(name);
      continue;
    }
    // Create missing roles and fill empty permission sets or missing modules
    const current = existing.find((r) => r.name === name);
    if (!current?.permissions || Object.keys(current.permissions).length === 0) {
      await RoleModel.updateOne({ name, isSystem: true }, { $set: { permissions: defaults } });
    } else {
      let needsUpdate = false;
      const updatedPerms = { ...current.permissions };
      for (const [mod, perms] of Object.entries(defaults)) {
        if (!updatedPerms[mod]) {
          updatedPerms[mod] = perms;
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        await RoleModel.updateOne(
          { name, isSystem: true },
          { $set: { permissions: updatedPerms } },
        );
      }
    }
  }
  return created;
};

export const Role = model("Role", roleSchema);
