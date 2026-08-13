import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { classifyBatchStatus } from "../utils/date.js";
import { constants } from "../config/constants.js";

export async function getStockSummary(medicineId) {
  const batches = await Batch.find({ medicineId }).sort({ "dates.expiryDate": 1 }).lean();
  const inventory = await InventoryItem.find({ batchId: { $in: batches.map((b) => b._id) } }).lean();

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
      expiryDate: b.dates?.expiryDate,
      status: classifyBatchStatus(b.dates?.expiryDate, constants.expiry.nearExpiryDays),
      mrp: b.pricing?.mrp,
      sellingPrice: b.pricing?.sellingPrice,
      currentStock: b.stock?.quantityOnHand ?? 0,
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
  const now = Date.now();
  const candidates = batches
    .filter(
      (b) => (b.stock?.quantityOnHand ?? 0) > 0 && new Date(b.dates?.expiryDate).getTime() > now,
    )
    .sort((a, b) => new Date(a.dates?.expiryDate) - new Date(b.dates?.expiryDate));

  const picks = [];
  let remaining = quantity;
  for (const batch of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(batch.stock?.quantityOnHand ?? 0, remaining);
    picks.push({ batchId: batch._id, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) throw ApiError.badRequest("Insufficient stock");
  return picks;
}
