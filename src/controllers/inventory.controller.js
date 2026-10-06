import { asyncHandler } from "../core/asyncHandler.js";
import { ok, created } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryLedger } from "../models/InventoryLedger.js";
import { StockMovement } from "../models/StockMovement.js";
import { addStock, removeStock, adjustStock } from "../services/inventory.service.js";
import { getStockSummary } from "../services/stock.service.js";
import { recordAudit } from "../services/audit.service.js";

export const listInventory = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.batchId) filter.batchId = req.query.batchId;
  if (req.query.locationType) filter.locationType = req.query.locationType;
  if (req.query.rackCode) filter.rackCode = { $regex: req.query.rackCode, $options: "i" };

  const [items, total] = await Promise.all([
    InventoryItem.find(filter)
      .populate({
        path: "batchId",
        populate: { path: "medicineId", select: "name genericName brandName" },
      })
      .skip(skip)
      .limit(limit)
      .lean(),
    InventoryItem.countDocuments(filter),
  ]);
  return ok(res, items, "Inventory", paginationMeta(total, { page, limit }));
});

export const getStockByMedicine = asyncHandler(async (req, res) => {
  const summary = await getStockSummary(req.params.medicineId);
  return ok(res, summary);
});

export const addStockToBatch = asyncHandler(async (req, res) => {
  const item = await addStock({
    ...req.body,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Stock added",
    entityType: "batch",
    entityId: req.body.batchId,
    ip: req.ip,
  });
  return created(res, item, "Stock added");
});

export const adjustStockLevel = asyncHandler(async (req, res) => {
  const item = await adjustStock({
    batchId: req.body.batchId,
    newQuantity: req.body.newQuantity,
    reason: req.body.reason,
    userId: req.user?._id,
    userName: req.user?.name,
  });
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Stock adjusted",
    entityType: "batch",
    entityId: req.body.batchId,
    ip: req.ip,
  });
  return ok(res, item, "Stock adjusted");
});

export const recordMovement = asyncHandler(async (req, res) => {
  const { movementType, quantityChange, ...rest } = req.body;
  if (quantityChange > 0) {
    await addStock({
      ...rest,
      quantity: quantityChange,
      userId: req.user?._id,
      userName: req.user?.name,
      note: req.body.note ?? movementType,
    });
  } else {
    await removeStock({
      ...rest,
      quantity: Math.abs(quantityChange),
      movementType,
      userId: req.user?._id,
      userName: req.user?.name,
      note: req.body.note ?? movementType,
    });
  }
  return created(res, null, "Movement recorded");
});

export const listLedger = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.batchId) filter.batchId = req.query.batchId;
  const [items, total] = await Promise.all([
    InventoryLedger.find(filter)
      .populate({ path: "batchId", populate: { path: "medicineId", select: "name" } })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    InventoryLedger.countDocuments(filter),
  ]);
  return ok(res, items, "Inventory ledger", paginationMeta(total, { page, limit }));
});

export const listStockMovements = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.medicineId) filter.medicineId = req.query.medicineId;
  const [items, total] = await Promise.all([
    StockMovement.find(filter)
      .populate("medicineId", "name")
      .populate("batchId", "batchNumber")
      .populate("createdBy", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    StockMovement.countDocuments(filter),
  ]);
  return ok(res, items, "Stock movements", paginationMeta(total, { page, limit }));
});
