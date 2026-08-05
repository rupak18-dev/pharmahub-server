import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { Notification } from "../models/Notification.js";
import { recordAudit } from "../services/audit.service.js";

export const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {
    $or: [{ userId: req.user?._id ?? null }, { userId: null }],
  };
  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return ok(res, items, "Notifications", paginationMeta(total, { page, limit }));
});

export const markRead = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const result = await Notification.updateMany(
    { _id: { $in: ids }, $or: [{ userId: req.user?._id ?? null }, { userId: null }] },
    { $set: { read: true, readAt: new Date() } },
  );
  return ok(res, result, "Notifications marked as read");
});

export const unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({
    read: false,
    $or: [{ userId: req.user?._id ?? null }, { userId: null }],
  });
  return ok(res, { count });
});

export const getNotification = asyncHandler(async (req, res) => {
  const item = await Notification.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Notification not found");
  return ok(res, item);
});

export const createNotification = asyncHandler(async (req, res) => {
  const item = await Notification.create(req.body);
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "Notification created", entityType: "notification", entityId: item._id, ip: req.ip });
  return ok(res, item, "Notification created");
});
