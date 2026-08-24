import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { generateId } from "../utils/id.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { recordAudit } from "../services/audit.service.js";

const QUARANTINE_DAYS = 14;

const ACTION_LABEL = {
  quarantine: "Batch quarantined",
  activate: "Batch activated",
  recall: "Batch recalled",
  block: "Batch blocked",
  retire: "Batch retired",
  updated: "Batch updated",
};

function serializeBatch(doc) {
  return { id: String(doc._id), ...doc };
}

function recordBatchMovement(batch, { type, note, qty = 0, from, to, by } = {}) {
  if (!Array.isArray(batch.movements)) batch.movements = [];
  batch.movements.push({
    id: generateId(),
    type,
    note,
    qty,
    timestamp: new Date(),
    from,
    to,
    by,
  });
  return batch;
}

export const listBatches = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = {};
  if (req.query.medicineId) filter.medicineId = req.query.medicineId;
  if (req.query.state) filter["status.state"] = req.query.state;
  if (req.query.search) filter.batchNumber = { $regex: req.query.search, $options: "i" };

  const [items, total] = await Promise.all([
    Batch.find(filter)
      .sort({ "dates.expiryDate": 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Batch.countDocuments(filter),
  ]);
  return ok(res, items.map(serializeBatch), "Batches", paginationMeta(total, { page, limit }));
});

export const getBatch = asyncHandler(async (req, res) => {
  const item = await Batch.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Batch not found");
  const locations = await InventoryItem.find({ batchId: item._id }).lean();
  return ok(res, serializeBatch({ ...item, locations }));
});

export const createBatch = asyncHandler(async (req, res) => {
  const now = new Date();
  const quantityOnHand = req.body.stock?.quantityOnHand ?? 0;

  // Guard against duplicate batch numbers regardless of whether the unique
  // index exists on the collection (legacy databases may still carry a
  // non-unique index from before the schema was updated).
  const existing = await Batch.findOne({
    medicineId: req.body.medicineId,
    batchNumber: req.body.batchNumber,
  })
    .select("_id")
    .lean();
  if (existing) {
    throw ApiError.conflict(
      `A batch with number "${req.body.batchNumber}" already exists for this medicine`,
    );
  }

  const batch = new Batch({
    ...req.body,
    audit: { createdAt: now, updatedAt: now, updatedBy: req.user?.name },
  });
  recordBatchMovement(batch, {
    type: "created",
    note: `Batch received · ${quantityOnHand} units`,
    qty: quantityOnHand,
    by: req.user?.name,
  });

  try {
    await batch.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict(
        `A batch with number "${req.body.batchNumber}" already exists for this medicine`,
      );
    }
    throw err;
  }

  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "Batch created",
    entityType: "batch",
    entityId: batch._id,
    ip: req.ip,
  });
  return created(res, serializeBatch(batch.toObject()), "Batch created");
});

export const updateBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw ApiError.notFound("Batch not found");

  const { action, reason, ...patch } = req.body;
  const now = new Date();
  const by = req.user?.name;
  let movementLogged = false;
  const log = (type, note, qty = 0) => {
    recordBatchMovement(batch, { type, note, qty, by });
    movementLogged = true;
  };

  if (action) {
    switch (action) {
      case "quarantine": {
        const onHand = batch.stock?.quantityOnHand ?? 0;
        const quarantined = batch.stock?.quarantined ?? 0;
        batch.status.state = "QUARANTINED";
        batch.status.quarantineReason = reason || "Awaiting QC";
        batch.dates.quarantineUntil = new Date(Date.now() + QUARANTINE_DAYS * 86400000);
        batch.stock.quarantined = quarantined + onHand;
        batch.stock.quantityOnHand = 0;
        log("quarantined", "Quarantined · awaiting QC", onHand);
        break;
      }
      case "activate": {
        const quarantined = batch.stock?.quarantined ?? 0;
        batch.status.state = "ACTIVE";
        batch.status.isRecalled = false;
        batch.status.quarantineReason = null;
        batch.dates.quarantineUntil = null;
        batch.stock.quantityOnHand = quarantined;
        batch.stock.quarantined = 0;
        log("activated", "Released from quarantine", quarantined);
        break;
      }
      case "recall":
        batch.status.state = "RECALLED";
        batch.status.isRecalled = true;
        batch.status.quarantineReason = reason || "Batch recalled";
        log("recalled", reason || "Batch recalled", 0);
        break;
      case "block":
        batch.status.state = "BLOCKED";
        batch.status.quarantineReason = reason || "Blocked by administrator";
        log("blocked", reason || "Batch blocked", 0);
        break;
      case "retire":
        batch.status.state = "RETIRED";
        batch.stock.quantityOnHand = 0;
        batch.stock.quarantined = 0;
        log("retired", "Batch retired", 0);
        break;
    }
  } else {
    if (patch.medicineId !== undefined) batch.medicineId = patch.medicineId;
    if (patch.supplierId !== undefined) batch.supplierId = patch.supplierId;
    if (patch.batchNumber !== undefined) batch.batchNumber = patch.batchNumber;
    if (patch.batchType !== undefined) batch.batchType = patch.batchType;
    if (patch.dates) Object.assign(batch.dates, patch.dates);
    if (patch.pricing) Object.assign(batch.pricing, patch.pricing);
    if (patch.status) Object.assign(batch.status, patch.status);
    if (patch.stock) {
      const before = batch.stock?.quantityOnHand ?? 0;
      Object.assign(batch.stock, patch.stock);
      const after = batch.stock?.quantityOnHand ?? 0;
      if (after !== before) {
        const diff = after - before;
        log("stock", `Stock adjusted · ${diff >= 0 ? "+" : ""}${diff}`, diff);
      }
    }
    if (patch.warehouse) {
      const movedTo = patch.warehouse.locationType ?? batch.warehouse?.locationType;
      const rack = patch.warehouse.rackCode ?? batch.warehouse?.rackCode;
      Object.assign(batch.warehouse, patch.warehouse);
      log("moved", `Moved to ${movedTo} / ${rack}`, 0);
    }
    if (!movementLogged) log("updated", "Batch details updated", 0);
  }

  batch.version = (batch.version ?? 1) + 1;
  batch.audit = { ...batch.audit, updatedAt: now, updatedBy: by };
  await batch.save();

  recordAudit({
    userId: req.user?._id,
    userName: by,
    action: ACTION_LABEL[action ?? "updated"],
    entityType: "batch",
    entityId: batch._id,
    ip: req.ip,
  });
  return ok(res, serializeBatch(batch.toObject()), ACTION_LABEL[action ?? "updated"]);
});

export const deleteBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw ApiError.notFound("Batch not found");
  if ((batch.stock?.quantityOnHand ?? 0) > 0) {
    throw ApiError.badRequest("Cannot delete a batch with stock on hand");
  }
  await InventoryItem.deleteMany({ batchId: batch._id });
  await batch.deleteOne();
  return noContent(res);
});
