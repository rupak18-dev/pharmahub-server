import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { Role } from "../models/Role.js";
import { constants } from "../config/constants.js";

export const listRoles = asyncHandler(async (_req, res) => {
  const roles = await Role.find().sort({ createdAt: 1 }).lean();
  const withDefaults = constants.roles.map((name) => {
    const existing = roles.find((r) => r.name === name);
    return existing ?? { name, permissions: {}, isSystem: true };
  });
  const custom = roles.filter((r) => !constants.roles.includes(r.name));
  return ok(res, [...withDefaults, ...custom]);
});

export const getRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id).lean();
  if (!role) throw ApiError.notFound("Role not found");
  return ok(res, role);
});

export const createRole = asyncHandler(async (req, res) => {
  const role = await Role.create(req.body);
  return created(res, role, "Role created");
});

export const updateRole = asyncHandler(async (req, res) => {
  const role = await Role.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
  if (!role) throw ApiError.notFound("Role not found");
  return ok(res, role, "Role updated");
});

export const deleteRole = asyncHandler(async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) throw ApiError.notFound("Role not found");
  if (role.isSystem) throw ApiError.badRequest("System roles cannot be deleted");
  await role.deleteOne();
  return ok(res, null, "Role deleted");
});
