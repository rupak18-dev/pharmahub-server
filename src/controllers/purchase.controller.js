import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { Purchase } from "../models/Purchase.js";
import {
  createPurchaseOrder,
  receivePurchase,
  updatePurchaseStatus,
} from "../services/purchase.service.js";
import { recordAudit } from "../services/audit.service.js";

export const listPurchases = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.supplierId) filter.supplierId = req.query.supplierId;
  const [items, total] = await Promise.all([
    Purchase.find(filter)
      .populate("supplierId", "name")
      .populate("createdBy", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Purchase.countDocuments(filter),
  ]);
  return ok(res, items, "Purchases", paginationMeta(total, { page, limit }));
});

export const getPurchase = asyncHandler(async (req, res) => {
  const item = await Purchase.findById(req.params.id)
    .populate("supplierId")
    .populate("createdBy", "name email")
    .populate("items.medicineId", "name genericName brandName")
    .lean();
  if (!item) throw ApiError.notFound("Purchase order not found");
  return ok(res, item);
});

export const createPurchase = asyncHandler(async (req, res) => {
  const item = await createPurchaseOrder({
    ...req.body,
    createdBy: req.user?._id,
    createdByName: req.user?.name,
  });
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Purchase order created",
    entityType: "purchase",
    entityId: item._id,
    ip: req.ip,
  });
  return created(res, item, "Purchase order created");
});

export const receive = asyncHandler(async (req, res) => {
  const result = await receivePurchase(req.params.id, req.body, req.user?._id, req.user?.name);
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Purchase received (GRN)",
    entityType: "purchase",
    entityId: req.params.id,
    ip: req.ip,
  });
  return ok(res, result, "Purchase received");
});

export const updateStatus = asyncHandler(async (req, res) => {
  const item = await updatePurchaseStatus(req.params.id, req.body.status);
  return ok(res, item, "Purchase status updated");
});

export const deletePurchase = asyncHandler(async (req, res) => {
  const item = await Purchase.findById(req.params.id);
  if (!item) throw ApiError.notFound("Purchase order not found");
  if (item.status === "received" || item.status === "partially_received") {
    throw ApiError.badRequest("Cannot delete a received purchase order");
  }
  await item.deleteOne();
  return noContent(res);
});
