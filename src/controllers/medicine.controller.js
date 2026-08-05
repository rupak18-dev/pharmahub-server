import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { generateBarcode } from "../utils/id.js";
import { Medicine } from "../models/Medicine.js";
import { Batch } from "../models/Batch.js";
import { recordAudit } from "../services/audit.service.js";
import { getStockSummary } from "../services/stock.service.js";

export const listMedicines = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (req.query.q) {
    filter.$or = [
      { name: { $regex: req.query.q, $options: "i" } },
      { genericName: { $regex: req.query.q, $options: "i" } },
      { brandName: { $regex: req.query.q, $options: "i" } },
      { barcode: { $regex: req.query.q, $options: "i" } },
    ];
  }
  delete filter.q;
  if (filter.isActive !== undefined) filter.isActive = filter.isActive === "true";

  const [items, total] = await Promise.all([
    Medicine.find(filter)
      .populate("categoryId", "name")
      .populate("manufacturerId", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Medicine.countDocuments(filter),
  ]);
  return ok(res, items, "Medicines", paginationMeta(total, { page, limit }));
});

export const getMedicine = asyncHandler(async (req, res) => {
  const item = await Medicine.findById(req.params.id)
    .populate("categoryId", "name")
    .populate("manufacturerId", "name")
    .lean();
  if (!item) throw ApiError.notFound("Medicine not found");
  const stock = await getStockSummary(item._id);
  return ok(res, { ...item, stock });
});

export const createMedicine = asyncHandler(async (req, res) => {
  const item = await Medicine.create({ ...req.body, barcode: req.body.barcode ?? generateBarcode() });
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "Medicine created", entityType: "medicine", entityId: item._id, ip: req.ip });
  return created(res, item, "Medicine created");
});

export const updateMedicine = asyncHandler(async (req, res) => {
  const item = await Medicine.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw ApiError.notFound("Medicine not found");
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "Medicine updated", entityType: "medicine", entityId: item._id, ip: req.ip });
  return ok(res, item, "Medicine updated");
});

export const deleteMedicine = asyncHandler(async (req, res) => {
  const batchCount = await Batch.countDocuments({ medicineId: req.params.id });
  const item = await Medicine.findById(req.params.id);
  if (!item) throw ApiError.notFound("Medicine not found");
  if (batchCount > 0) {
    throw ApiError.badRequest("Cannot delete a medicine that has batches; deactivate it instead");
  }
  await item.deleteOne();
  return noContent(res);
});
