import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";

export async function getStockSummary(medicineId) {
  const batches = await Batch.find({ medicineId }).sort({ expiryDate: 1 }).lean();
  const inventory = await InventoryItem.find({
    batchId: { $in: batches.map((b) => b._id) },
  }).lean();

  const total = inventory.reduce((sum, i) => sum + i.quantityOnHand, 0);
  const reserved = inventory.reduce((sum, i) => sum + i.reservedQuantity, 0);

  return {
    medicineId,
    totalQuantity: total,
    reservedQuantity: reserved,
    availableQuantity: Math.max(0, total - reserved),
    batchCount: batches.length,
    batches: batches.map((b) => ({
      id: String(b._id),
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      status: b.status,
      mrp: b.mrp,
      sellingPrice: b.sellingPrice,
      currentStock: b.currentStock,
      locations: inventory
        .filter((i) => String(i.batchId) === String(b._id))
        .map((i) => ({
          locationType: i.locationType,
          rackCode: i.rackCode,
          quantityOnHand: i.quantityOnHand,
        })),
    })),
  };
}

export function pickBatchesFEFO(batches, quantity) {
  const candidates = batches
    .filter((b) => b.status !== "expired" && b.currentStock > 0)
    .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  const picks = [];
  let remaining = quantity;
  for (const batch of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(batch.currentStock, remaining);
    picks.push({ batchId: batch._id, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) throw ApiError.badRequest("Insufficient stock");
  return picks;
}
