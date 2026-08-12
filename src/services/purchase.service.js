import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { Medicine } from "../models/Medicine.js";
import { Purchase } from "../models/Purchase.js";
import { addStock } from "./inventory.service.js";
import { generateNumericId } from "../utils/id.js";
import { round2 } from "../utils/date.js";

export async function createPurchaseOrder({ supplierId, items, discount = 0, notes, createdBy, createdByName }) {
  const medicineIds = items.map((i) => i.medicineId);
  const meds = await Medicine.find({ _id: { $in: medicineIds } }).lean();
  const medMap = new Map(meds.map((m) => [String(m._id), m]));

  const orderItems = items.map((item) => {
    const med = medMap.get(String(item.medicineId));
    if (!med) throw ApiError.badRequest(`Unknown medicine ${item.medicineId}`);
    const gross = item.quantity * item.unitCost;
    return {
      medicineId: item.medicineId,
      medicineName: med.name,
      quantity: item.quantity,
      quantityReceived: 0,
      unitCost: item.unitCost,
      gstRate: item.gstRate ?? med.gstRate ?? 0,
      lineTotal: round2(gross),
    };
  });

  const subtotal = round2(orderItems.reduce((s, i) => s + i.lineTotal, 0));
  const gstTotal = round2(
    orderItems.reduce((s, i) => s + i.lineTotal * (i.gstRate / 100), 0),
  );
  const grandTotal = round2(subtotal - discount + gstTotal);

  const orderNo = `PO-${Date.now().toString().slice(-8)}-${generateNumericId(3)}`;
  return Purchase.create({
    orderNo,
    supplierId,
    items: orderItems,
    subtotal,
    discount,
    gstTotal,
    grandTotal,
    status: "ordered",
    notes,
    createdBy,
    createdByName,
    orderedAt: new Date(),
  });
}

export async function receivePurchase(purchaseId, { items }, userId, userName) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const purchase = await Purchase.findById(purchaseId).session(session);
      if (!purchase) throw ApiError.notFound("Purchase order not found");
      if (purchase.status === "cancelled") throw ApiError.badRequest("Cannot receive a cancelled order");

      const receivedByItem = new Map(items.map((i) => [String(i.itemId), i]));
      let allReceived = true;

      for (const item of purchase.items) {
        const incoming = receivedByItem.get(String(item._id));
        if (!incoming) continue;
        if (incoming.quantityReceived > item.quantity - item.quantityReceived) {
          throw ApiError.badRequest(`Received quantity exceeds ordered quantity for item ${item._id}`);
        }
      }

      for (const incoming of items) {
        const item = purchase.items.find((i) => String(i._id) === String(incoming.itemId));
        if (!item) throw ApiError.badRequest(`Unknown purchase line ${incoming.itemId}`);

        item.quantityReceived += incoming.quantityReceived;
        if (item.quantityReceived < item.quantity) allReceived = false;

        const existingBatch = await Batch.findOne({
          medicineId: item.medicineId,
          batchNumber: incoming.batchNumber,
        }).session(session);

        let batch = existingBatch;
        if (batch) {
          batch.pricing.purchasePrice = item.unitCost;
          if (incoming.mrp != null) batch.pricing.mrp = incoming.mrp;
          if (incoming.sellingPrice != null) batch.pricing.sellingPrice = incoming.sellingPrice;
          if (incoming.expiryDate) batch.dates.expiryDate = incoming.expiryDate;
        } else {
          batch = await Batch.create(
            [{
              medicineId: item.medicineId,
              batchNumber: incoming.batchNumber ?? `BATCH-${generateNumericId(6)}`,
              batchType: "C",
              dates: {
                manufacturingDate: incoming.mfgDate ?? new Date(),
                expiryDate: incoming.expiryDate ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
              },
              pricing: {
                purchasePrice: item.unitCost,
                mrp: incoming.mrp ?? 0,
                sellingPrice: incoming.sellingPrice ?? round2(item.unitCost * 1.2),
                gstRate: item.gstRate ?? 0,
              },
              status: { state: "ACTIVE" },
              stock: { uom: "Units", quantityOnHand: 0, reservedQuantity: 0, quarantined: 0 },
              warehouse: {
                locationType: incoming.locationType ?? "Front Shelf",
                rackCode: incoming.rackCode ?? "UNASSIGNED",
              },
              supplierId: purchase.supplierId,
            }],
            { session },
          );
          batch = batch[0];
        }

        await addStock({
          batchId: batch._id,
          locationType: incoming.locationType ?? "Front Shelf",
          rackCode: incoming.rackCode ?? "UNASSIGNED",
          quantity: incoming.quantityReceived,
          referenceDocId: purchase._id,
          userId,
          userName,
          note: `GRN for ${purchase.orderNo}`,
        });

        item.batchId = batch._id;
      }

      purchase.status = allReceived ? "received" : "partially_received";
      purchase.receivedAt = new Date();
      await purchase.save({ session });
      result = { purchase: await Purchase.findById(purchaseId).populate("supplierId").session(session), allReceived };
    });
    return result;
  } finally {
    session.endSession();
  }
}

export async function updatePurchaseStatus(purchaseId, status) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw ApiError.notFound("Purchase order not found");
  if (status === "cancelled" && purchase.status === "received") {
    throw ApiError.badRequest("Cannot cancel a fully received order");
  }
  purchase.status = status;
  await purchase.save();
  return purchase;
}
