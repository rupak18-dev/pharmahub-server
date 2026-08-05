import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { AuditLog } from "../models/AuditLog.js";
import { recordAudit } from "../services/audit.service.js";

export const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.userId) filter.userId = req.query.userId;
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.action) filter.action = { $regex: req.query.action, $options: "i" };
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  return ok(res, items, "Audit logs", paginationMeta(total, { page, limit }));
});

export const getAuditLog = asyncHandler(async (req, res) => {
  const item = await AuditLog.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Audit log not found");
  return ok(res, item);
});

export const createAuditLog = asyncHandler(async (req, res) => {
  const item = await AuditLog.create({
    ...req.body,
    userId: req.user?._id,
    userName: req.user?.name,
    ip: req.ip,
  });
  return created(res, item, "Audit log recorded");
});

export { recordAudit as _recordAuditHelper };
