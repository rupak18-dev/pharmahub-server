import mongoose from "mongoose";
import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { Role, DEFAULT_ROLE_PERMISSIONS } from "../models/Role.js";
import { User } from "../models/User.js";
import { constants } from "../config/constants.js";

// Only keep permission entries for known modules/actions; discard the rest.
function sanitizePermissions(permissions) {
  const allowedActions = new Set(constants.actions);
  const clean = {};
  for (const module of constants.modules) {
    const actions = permissions?.[module];
    if (!actions || typeof actions !== "object") continue;
    const entry = {};
    for (const action of allowedActions) {
      if (typeof actions[action] === "boolean") entry[action] = actions[action];
    }
    if (Object.keys(entry).length > 0) clean[module] = entry;
  }
  return clean;
}

export const listRoles = asyncHandler(async (_req, res) => {
  const roles = await Role.find().sort({ createdAt: 1 }).lean();

  // Aggregate user counts per role in one query. Removed (soft-deleted) users
  // are excluded so an assignment count never includes accounts that can no
  // longer sign in.
  const roleCounts = await User.aggregate([
    { $match: { status: { $ne: "removed" } } },
    { $group: { _id: "$role", count: { $sum: 1 } } },
  ]);
  const countMap = {};
  for (const rc of roleCounts) {
    countMap[rc._id] = rc.count;
  }

  const withDefaults = constants.roles.map((name) => {
    const existing = roles.find((r) => r.name === name);
    // The persisted Role record is the source of truth for system roles too.
    // Defaults are only used as a defensive fallback when no record exists yet
    // (e.g. before ensureSystemRoles has run) — an existing record is returned
    // verbatim, even if its permission set was deliberately cleared.
    const permissions = existing ? existing.permissions : (DEFAULT_ROLE_PERMISSIONS[name] ?? {});
    return {
      ...(existing ?? { name, isSystem: true }),
      id: existing?._id ?? null,
      permissions,
      assignedUsersCount: countMap[name] ?? 0,
    };
  });

  const custom = roles
    .filter((r) => !constants.roles.includes(r.name))
    .map((r) => ({ ...r, id: r._id, assignedUsersCount: countMap[r.name] ?? 0 }));

  return ok(res, [...withDefaults, ...custom]);
});

export const getRole = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let role;
  if (mongoose.Types.ObjectId.isValid(id)) {
    role = await Role.findById(id).lean();
  }
  if (!role) {
    role = await Role.findOne({ name: id }).lean();
  }
  if (!role) throw ApiError.notFound("Role not found");
  return ok(res, { ...role, id: role._id });
});

export const createRole = asyncHandler(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw ApiError.badRequest("Role name is required");

  const existing = await Role.findOne({ name });
  if (existing) throw ApiError.conflict("A role with this name already exists");

  const role = await Role.create({
    name,
    description: String(req.body?.description ?? "").trim(),
    department: String(req.body?.department ?? "").trim(),
    active: req.body?.active === false ? false : true,
    permissions: sanitizePermissions(req.body?.permissions),
    isSystem: false,
  });
  return created(res, { ...role.toObject(), id: role._id }, "Role created");
});

export const updateRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound("Role not found");

  const update = {};
  if (req.body?.name !== undefined) {
    if (role.isSystem) throw ApiError.badRequest("System role names cannot be changed");
    const name = String(req.body.name).trim();
    if (!name) throw ApiError.badRequest("Role name cannot be empty");
    update.name = name;
  }
  if (req.body?.description !== undefined) {
    update.description = String(req.body.description ?? "").trim();
  }
  if (req.body?.department !== undefined) {
    update.department = String(req.body.department ?? "").trim();
  }
  if (req.body?.active !== undefined) {
    // Owner/Admin must stay enabled — disabling them would lock everyone out.
    if (req.body.active === false && ["Owner", "Admin"].includes(role.name)) {
      throw ApiError.badRequest(`The "${role.name}" role cannot be disabled`);
    }
    update.active = Boolean(req.body.active);
  }
  if (req.body?.permissions !== undefined) {
    update.permissions = sanitizePermissions(req.body.permissions);
  }

  if (Object.keys(update).length === 0) {
    return ok(res, { ...role.toObject(), id: role._id }, "Role updated");
  }

  const updated = await Role.findByIdAndUpdate(
    req.params.id,
    { $set: update },
    { new: true, runValidators: true },
  );
  return ok(res, { ...updated.toObject(), id: updated._id }, "Role updated");
});

export const deleteRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound("Role not found");
  if (role.isSystem) throw ApiError.badRequest("System roles cannot be deleted");
  if (["Owner", "Admin"].includes(role.name)) {
    throw ApiError.badRequest(`The "${role.name}" role cannot be deleted`);
  }

  const assigned = await User.countDocuments({ role: role.name, status: { $ne: "removed" } });
  if (assigned > 0) {
    throw ApiError.conflict(
      `Cannot delete role "${role.name}" because it is assigned to ${assigned} user(s)`,
    );
  }

  await role.deleteOne();
  return ok(res, null, "Role deleted");
});
