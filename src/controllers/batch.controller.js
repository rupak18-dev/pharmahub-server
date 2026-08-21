import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { recordAudit } from "../services/audit.service.js";
import { refreshBatchStatus } from "../services/batch.service.js";

export const listBatches = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (req.query.medicineId) filter.medicineId = req.query.medicineId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.expiryDate) {
    filter.expiryDate = { $lte: new Date(req.query.expiryDate) };
  }
  delete filter.medicineId;
  delete filter.status;
  delete filter.expiryDate;

  const [items, total] = await Promise.all([
    Batch.find(filter)
      .populate("medicineId", "name genericName brandName prefix")
      .populate("supplierId", "name")
      .sort({ expiryDate: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Batch.countDocuments(filter),
  ]);
  return ok(res, items, "Batches", paginationMeta(total, { page, limit }));
});

export const getBatch = asyncHandler(async (req, res) => {
  const item = await Batch.findById(req.params.id)
    .populate("medicineId")
    .populate("supplierId", "name")
    .lean();
  if (!item) throw ApiError.notFound("Batch not found");
  const locations = await InventoryItem.find({ batchId: item._id }).lean();
  return ok(res, { ...item, locations });
});

export const createBatch = asyncHandler(async (req, res) => {
  const batch = new Batch(req.body);
  await refreshBatchStatus(batch);
  await batch.save();
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Batch created",
    entityType: "batch",
    entityId: batch._id,
    ip: req.ip,
  });
  return created(res, batch, "Batch created");
});

export const updateBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw ApiError.notFound("Batch not found");
  Object.assign(batch, req.body);
  await refreshBatchStatus(batch);
  await batch.save();
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Batch updated",
    entityType: "batch",
    entityId: batch._id,
    ip: req.ip,
  });
  return ok(res, batch, "Batch updated");
});

export const deleteBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw ApiError.notFound("Batch not found");
  if ((batch.currentStock ?? 0) > 0) {
    throw ApiError.badRequest("Cannot delete a batch with stock on hand");
  }
  await InventoryItem.deleteMany({ batchId: batch._id });
  await batch.deleteOne();
  return noContent(res);
});
