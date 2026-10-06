import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { Supplier } from "../models/Supplier.js";
import { recordAudit } from "../services/audit.service.js";

export const listSuppliers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (req.query.q) {
    const regex = { $regex: req.query.q, $options: "i" };
    filter.$or = [{ name: regex }, { contactInfo: regex }, { gstNumber: regex }];
  }
  delete filter.q;
  const [items, total] = await Promise.all([
    Supplier.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Supplier.countDocuments(filter),
  ]);
  return ok(res, items, "Suppliers", paginationMeta(total, { page, limit }));
});

export const getSupplier = asyncHandler(async (req, res) => {
  const item = await Supplier.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Supplier not found");
  return ok(res, item);
});

export const createSupplier = asyncHandler(async (req, res) => {
  const item = await Supplier.create(req.body);
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Supplier created",
    entityType: "supplier",
    entityId: item._id,
    ip: req.ip,
  });
  return created(res, item, "Supplier created");
});

export const updateSupplier = asyncHandler(async (req, res) => {
  const item = await Supplier.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!item) throw ApiError.notFound("Supplier not found");
  return ok(res, item, "Supplier updated");
});

export const deleteSupplier = asyncHandler(async (req, res) => {
  const item = await Supplier.findById(req.params.id);
  if (!item) throw ApiError.notFound("Supplier not found");
  await item.deleteOne();
  return noContent(res);
});
