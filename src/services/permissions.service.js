import { Role, DEFAULT_ROLE_PERMISSIONS } from "../models/Role.js";
import { constants } from "../config/constants.js";

// Effective-permission model:
//   effective(module, action) = user override ?? role default ?? false
// Users store ONLY explicit overrides (the deltas the Owner configured during
// invitation / staff access editing). Role defaults come from the Role
// collection and are never rewritten by per-user restrictions, so restricting
// one user can never corrupt the global role defaults.

// Map values in a NON-lean document are Mongoose subdocuments — spreading one
// with `{...actions}` yields its internal `_doc`/`$__` paths instead of the
// schema getters (view/create/...). Convert every value to a plain object so
// merges/sanitization always see clean `{ action: boolean }` maps.
function toPlain(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value.toObject === "function") return value.toObject();
  return value;
}

export function normalizePermissions(value) {
  if (!value) return {};
  if (value instanceof Map) {
    const out = {};
    for (const [key, val] of value) out[key] = toPlain(val);
    return out;
  }
  if (value && typeof value.toObject === "function") return value.toObject();
  return value;
}

// Keep only known modules/actions so arbitrary keys can never sneak in.
export function sanitizePermissionOverrides(permissions) {
  const allowedActions = new Set(constants.actions);
  const clean = {};
  for (const [mod, actions] of Object.entries(normalizePermissions(permissions))) {
    if (!constants.modules.includes(mod)) continue;
    if (!actions || typeof actions !== "object") continue;
    const entry = {};
    for (const action of allowedActions) {
      if (typeof actions[action] === "boolean") entry[action] = actions[action];
    }
    if (Object.keys(entry).length > 0) clean[mod] = entry;
  }
  return clean;
}

// Explicit overrides win over role defaults, action by action. Modules not
// mentioned in the overrides keep their role default. Deny-by-default for
// anything undefined.
export function mergePermissionOverrides(rolePerms, overrides) {
  const merged = {};
  const base = normalizePermissions(rolePerms);
  for (const [mod, actions] of Object.entries(base)) {
    merged[mod] = { ...actions };
  }
  for (const [mod, actions] of Object.entries(normalizePermissions(overrides))) {
    if (!actions || typeof actions !== "object") continue;
    merged[mod] = { ...(merged[mod] ?? {}), ...actions };
  }
  return merged;
}

function viewOnly(modules) {
  return Object.fromEntries(
    modules.map((mod) => [
      mod,
      { view: true, create: false, update: false, delete: false, approve: false, export: false },
    ]),
  );
}
const ROLELESS_PERMISSIONS = viewOnly([
  "dashboard",
  "medicines",
  "batches",
  "expiry",
  "reports",
]);

export async function getRolePermissions(roleName) {
  if (!roleName) return {};
  const role = await Role.findOne({ name: roleName }).lean();
  const stored = normalizePermissions(role?.permissions);
  // A missing/empty Role record must never lock an entire role out of every
  // module — fall back to the built-in default matrix for that role so
  // authorization keeps working on fresh/misprovisioned databases.
  if (!role || Object.keys(stored).length === 0) {
    return DEFAULT_ROLE_PERMISSIONS[roleName] ?? ROLELESS_PERMISSIONS;
  }
  return stored;
}

// Role-less accounts (self-registered / Google-provisioned, awaiting an
// explicit role assignment) get a read-only baseline so they can use the app
// shell without being hard-locked out. All mutations stay denied until the
// Owner grants a real role — this is NOT a functional default role.

// Capability toggles (featureAccess) are applied LAST so they always win over
// role defaults, per-user overrides and the accessIds whitelist. They express
// the Owner's intent as absolute action denials — computed here against the
// REAL role defaults instead of being pre-baked into per-user override deltas
// by the frontend (which cannot know the server's current role configuration).
function applyFeatureAccess(perms, featureAccess) {
  if (!featureAccess || typeof featureAccess !== "object") return perms;
  const deny = (mod, actions) => {
    if (!perms[mod]) return;
    for (const action of actions) perms[mod][action] = false;
  };
  if (featureAccess.processSales === false) deny("sales", ["create", "update", "approve"]);
  if (featureAccess.stockAudit === false) deny("audit", ["create", "update", "delete"]);
  if (featureAccess.purchasing === false) deny("purchases", ["create", "update", "approve"]);
  if (featureAccess.notifications === false) deny("notifications", ["view"]);
  if (featureAccess.userAdmin === false) {
    deny("users", ["create", "update", "delete", "approve"]);
  }
  if (featureAccess.dataExport === false) {
    for (const mod of Object.keys(perms)) {
      if (perms[mod]) perms[mod].export = false;
    }
  }
  return perms;
}

export async function getEffectivePermissions(user) {
  if (!user) return {};
  const rolePerms = user.role ? await getRolePermissions(user.role) : ROLELESS_PERMISSIONS;
  const baseMerged = mergePermissionOverrides(rolePerms, user.permissions);

  // If user has an explicit accessIds module whitelist configured, enforce it:
  // 1. Any module not in accessIds is completely denied.
  // 2. Any module in accessIds will have at least { view: true } enabled unless explicitly overridden.
  let result;
  if (Array.isArray(user.accessIds) && user.accessIds.length > 0) {
    const whitelist = new Set(user.accessIds);
    const whitelisted = {};
    for (const mod of constants.modules) {
      if (!whitelist.has(mod)) {
        whitelisted[mod] = {
          view: false,
          create: false,
          update: false,
          delete: false,
          approve: false,
          export: false,
        };
      } else {
        const current = { ...(baseMerged[mod] ?? {}) };
        const userOverrides = normalizePermissions(user.permissions);
        if (!current.view && userOverrides[mod]?.view !== false) {
          current.view = true;
        }
        whitelisted[mod] = current;
      }
    }
    result = whitelisted;
  } else {
    result = baseMerged;
  }

  return applyFeatureAccess(result, user.featureAccess);
}
