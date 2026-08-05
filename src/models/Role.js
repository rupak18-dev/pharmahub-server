import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const actionDefaults = Object.fromEntries(constants.actions.map((a) => [a, false]));
const emptyModulePermissions = Object.fromEntries(constants.modules.map((m) => [m, actionDefaults]));

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

const DEFAULT_ROLE_PERMISSIONS = {
  Owner: rolePermissions(() => all()),
  Admin: rolePermissions(() => all()),
  Pharmacist: rolePermissions((m) => {
    if (m === "sales") return { ...all(), delete: false, approve: false };
    if (["medicines", "batches", "inventory", "expiry", "notifications"].includes(m))
      return { ...viewExport(), update: true };
    if (["dashboard", "reports", "ai"].includes(m)) return viewExport();
    return view();
  }),
  Cashier: rolePermissions((m) => {
    if (m === "sales") return { ...none(), view: true, create: true };
    if (["dashboard", "medicines", "batches"].includes(m)) return view();
    return none();
  }),
  "Store Keeper": rolePermissions((m) => {
    if (["inventory", "batches"].includes(m)) return { ...view(), create: true, update: true };
    if (["dashboard", "medicines", "expiry", "audit", "notifications"].includes(m)) return view();
    return none();
  }),
  "Inventory Manager": rolePermissions((m) => {
    if (["medicines", "batches", "inventory", "expiry", "audit", "purchases"].includes(m))
      return { ...all(), delete: m === "batches" };
    if (["dashboard", "reports", "notifications", "ai"].includes(m)) return viewExport();
    return view();
  }),
};

const roleSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
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
  const existing = await RoleModel.find({ isSystem: true }).select("name").lean();
  const existingNames = new Set(existing.map((r) => r.name));
  const created = [];
  for (const name of constants.roles) {
    const defaults = DEFAULT_ROLE_PERMISSIONS[name] ?? emptyModulePermissions;
    if (!existingNames.has(name)) {
      await RoleModel.create({ name, permissions: defaults, isSystem: true });
      created.push(name);
      continue;
    }
    // Repair drifted permissions on existing system roles.
    await RoleModel.updateOne({ name, isSystem: true }, { $set: { permissions: defaults } });
  }
  return created;
};

export const Role = model("Role", roleSchema);
