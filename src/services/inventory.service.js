import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryLedger } from "../models/InventoryLedger.js";
import { StockMovement } from "../models/StockMovement.js";

export async function ensureInventoryRecord({ batchId, locationType, rackCode }) {
  const existing = await InventoryItem.findOne({ batchId, locationType, rackCode });
  if (existing) return existing;
  return InventoryItem.create({ batchId, locationType, rackCode, quantityOnHand: 0 });
}

export async function addStock({ batchId, locationType, rackCode, quantity, referenceDocId, userId, userName, note }) {
  if (quantity <= 0) throw ApiError.badRequest("Quantity must be positive");
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const batch = await Batch.findById(batchId).session(session);
      if (!batch) throw ApiError.notFound("Batch not found");

      const record = await ensureInventoryRecord({ batchId, locationType, rackCode });
      item = await InventoryItem.findByIdAndUpdate(
        record._id,
        { $inc: { quantityOnHand: quantity } },
        { new: true, session },
      );

      batch.stock.quantityOnHand += quantity;
      await batch.save({ session });

      await InventoryLedger.create(
        [{ batchId, movementType: "Purchase Inward", quantityChange: quantity, userId, userName, referenceDocId, note }],
        { session },
      );
      await StockMovement.create(
        [{ medicineId: batch.medicineId, batchId, movementType: "in", quantity, reason: note ?? "Stock added", referenceDocId, createdBy: userId, createdByName: userName }],
        { session },
      );
    });
    return item;
  } finally {
    session.endSession();
  }
}

export async function removeStock({ batchId, locationType, rackCode, quantity, movementType, referenceDocId, userId, userName, note }) {
  if (quantity <= 0) throw ApiError.badRequest("Quantity must be positive");
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const record = await ensureInventoryRecord({ batchId, locationType, rackCode });
      if (record.quantityOnHand < quantity) {
        throw ApiError.badRequest("Insufficient stock at the selected location");
      }

      item = await InventoryItem.findByIdAndUpdate(
        record._id,
        { $inc: { quantityOnHand: -quantity } },
        { new: true, session },
      );

      await Batch.findByIdAndUpdate(batchId, { $inc: { "stock.quantityOnHand": -quantity } }, { session });
      await InventoryLedger.create(
        [{ batchId, movementType, quantityChange: -quantity, userId, userName, referenceDocId, note }],
        { session },
      );
      await StockMovement.create(
        [{ medicineId: (await Batch.findById(batchId).session(session))?.medicineId, batchId, movementType: "out", quantity, reason: note ?? movementType, referenceDocId, createdBy: userId, createdByName: userName }],
        { session },
      );
    });
    return item;
  } finally {
    session.endSession();
  }
}

export async function adjustStock({ batchId, newQuantity, reason, userId, userName }) {
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const batch = await Batch.findById(batchId).session(session);
      if (!batch) throw ApiError.notFound("Batch not found");
      const record = await InventoryItem.findOne({ batchId }).session(session);
      if (!record) throw ApiError.notFound("No inventory record for this batch");

      const oldQuantity = record.quantityOnHand;
      const delta = newQuantity - oldQuantity;
      item = await InventoryItem.findByIdAndUpdate(record._id, { quantityOnHand: newQuantity }, { new: true, session });

      batch.stock.quantityOnHand = Math.max(0, batch.stock.quantityOnHand + delta);
      await batch.save({ session });

      await InventoryLedger.create(
        [{ batchId, movementType: "Stock Adjustment", quantityChange: delta, userId, userName, note: reason }],
        { session },
      );
      if (delta !== 0) {
        await StockMovement.create(
          [{ medicineId: batch.medicineId, batchId, movementType: "adjustment", quantity: Math.abs(delta), reason: reason ?? "Stock adjustment", createdBy: userId, createdByName: userName }],
          { session },
        );
      }
    });
    return item;
  } finally {
    session.endSession();
  }
}
