import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { Sale } from "../models/Sale.js";
import { createSale, voidSale } from "../services/sale.service.js";
import { recordAudit } from "../services/audit.service.js";

export const listSales = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }
  const [items, total] = await Promise.all([
    Sale.find(filter)
      .populate("createdBy", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Sale.countDocuments(filter),
  ]);
  return ok(res, items, "Sales", paginationMeta(total, { page, limit }));
});

export const getSale = asyncHandler(async (req, res) => {
  const item = await Sale.findById(req.params.id)
    .populate("createdBy", "name email")
    .populate("items.medicineId", "name genericName brandName")
    .populate("items.batchId", "batchNumber")
    .lean();
  if (!item) throw ApiError.notFound("Sale not found");
  return ok(res, item);
});

export const create = asyncHandler(async (req, res) => {
  const item = await createSale({
    ...req.body,
    createdBy: req.user?._id,
    createdByName: req.user?.name,
  });
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: `Sale ${item.invoiceNo} completed`, entityType: "sale", entityId: item._id, ip: req.ip });
  return created(res, item, "Sale completed");
});

export const voidSaleById = asyncHandler(async (req, res) => {
  const item = await voidSale(req.params.id, req.body.reason, req.user?._id, req.user?.name);
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: `Sale ${item.invoiceNo} voided`, entityType: "sale", entityId: item._id, ip: req.ip });
  return ok(res, item, "Sale voided and stock restored");
});
