import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { User } from "../models/User.js";
import { recordAudit } from "../services/audit.service.js";
import { toPublicUser } from "../services/auth.service.js";
import bcrypt from "bcryptjs";

export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (filter.active !== undefined) filter.active = filter.active === "true";
  delete filter.role;
  if (req.query.role) filter.role = req.query.role;

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  return ok(res, users.map(toPublicUser), "Users", paginationMeta(total, { page, limit }));
});

export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).lean();
  if (!user) throw ApiError.notFound("User not found");
  return ok(res, toPublicUser(user));
});

export const createUser = asyncHandler(async (req, res) => {
  const existing = await User.findOne({ email: req.body.email.toLowerCase() });
  if (existing) throw ApiError.conflict("A user with this email already exists");
  const passwordHash = await bcrypt.hash(req.body.password, 10);
  const user = await User.create({ ...req.body, email: req.body.email.toLowerCase(), passwordHash });
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "User created", entityType: "user", entityId: user._id, ip: req.ip });
  return created(res, toPublicUser(user.toObject()), "User created");
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound("User not found");
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "User updated", entityType: "user", entityId: user._id, ip: req.ip });
  return ok(res, toPublicUser(user.toObject()), "User updated");
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound("User not found");
  if (String(user._id) === String(req.user?._id)) {
    throw ApiError.badRequest("You cannot delete your own account");
  }
  await user.deleteOne();
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "User deleted", entityType: "user", entityId: req.params.id, ip: req.ip });
  return noContent(res);
});
