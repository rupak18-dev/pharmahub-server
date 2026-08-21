import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { Medicine } from "../models/Medicine.js";
import { Sale } from "../models/Sale.js";
import { removeStock } from "./inventory.service.js";
import { generateInvoiceNo } from "../utils/id.js";
import { round2 } from "../utils/date.js";

export async function createSale({
  customerName,
  customerPhone,
  items,
  paymentMode,
  tender,
  createdBy,
  createdByName,
}) {
  const session = await mongoose.startSession();
  try {
    let sale;
    await session.withTransaction(async () => {
      const medicineIds = items.map((i) => i.medicineId);
      const meds = await Medicine.find({ _id: { $in: medicineIds } }).lean();
      const medMap = new Map(meds.map((m) => [String(m._id), m]));

      const saleItems = [];
      let subtotal = 0;
      let discountTotal = 0;
      let gstTotal = 0;

      for (const line of items) {
        const med = medMap.get(String(line.medicineId));
        if (!med) throw ApiError.badRequest(`Unknown medicine ${line.medicineId}`);

        const candidates = await Batch.find({ medicineId: med._id, status: { $ne: "expired" } })
          .sort({ expiryDate: 1 })
          .session(session);
        const locations = await InventoryItem.find({
          batchId: { $in: candidates.map((b) => b._id) },
        }).session(session);
        const qtyByBatch = new Map();
        for (const loc of locations) {
          qtyByBatch.set(
            String(loc.batchId),
            (qtyByBatch.get(String(loc.batchId)) ?? 0) + loc.quantityOnHand,
          );
        }

        let remaining = line.quantity;
        for (const batch of candidates) {
          if (remaining <= 0) break;
          const available = qtyByBatch.get(String(batch._id)) ?? 0;
          if (available <= 0) continue;
          const take = Math.min(available, remaining);
          const loc =
            locations.find(
              (l) => String(l.batchId) === String(batch._id) && l.quantityOnHand >= take,
            ) ?? locations.find((l) => String(l.batchId) === String(batch._id));

          if (!loc) {
            // Take from the first location with any stock, reducing proportionally.
            const targetLoc = locations.find((l) => String(l.batchId) === String(batch._id));
            if (!targetLoc) continue;
            const fromLoc = { ...targetLoc };
            const takeFromLoc = Math.min(fromLoc.quantityOnHand, take);
            await removeStock({
              batchId: batch._id,
              locationType: fromLoc.locationType,
              rackCode: fromLoc.rackCode,
              quantity: takeFromLoc,
              movementType: "Sales Outward",
              referenceDocId: null,
              userId: createdBy,
              userName: createdByName,
              note: "Sales outward",
            });
            const unit = batch.sellingPrice ?? 0;
            const gross = unit * takeFromLoc;
            const discount = (gross * (line.discountPct ?? 0)) / 100;
            const net = gross - discount;
            const gst = (net * (med.gstRate ?? 0)) / 100;
            saleItems.push({
              medicineId: med._id,
              batchId: batch._id,
              medicineName: med.name,
              batchNumber: batch.batchNumber,
              quantity: takeFromLoc,
              unitPrice: unit,
              discountPct: line.discountPct ?? 0,
              gstRate: med.gstRate ?? 0,
              lineTotal: round2(net + gst),
            });
            subtotal += gross;
            discountTotal += discount;
            gstTotal += gst;
            remaining -= takeFromLoc;
          } else {
            await removeStock({
              batchId: batch._id,
              locationType: loc.locationType,
              rackCode: loc.rackCode,
              quantity: take,
              movementType: "Sales Outward",
              referenceDocId: null,
              userId: createdBy,
              userName: createdByName,
              note: "Sales outward",
            });
            const unit = batch.sellingPrice ?? 0;
            const gross = unit * take;
            const discount = (gross * (line.discountPct ?? 0)) / 100;
            const net = gross - discount;
            const gst = (net * (med.gstRate ?? 0)) / 100;
            saleItems.push({
              medicineId: med._id,
              batchId: batch._id,
              medicineName: med.name,
              batchNumber: batch.batchNumber,
              quantity: take,
              unitPrice: unit,
              discountPct: line.discountPct ?? 0,
              gstRate: med.gstRate ?? 0,
              lineTotal: round2(net + gst),
            });
            subtotal += gross;
            discountTotal += discount;
            gstTotal += gst;
            remaining -= take;
          }
        }

        if (remaining > 0) {
          throw ApiError.badRequest(`Insufficient stock for ${med.name}`);
        }
      }

      const rawGrand = subtotal - discountTotal + gstTotal;
      const grandTotal = Math.round(rawGrand);
      const roundOff = round2(grandTotal - rawGrand);

      sale = await Sale.create(
        [
          {
            invoiceNo: generateInvoiceNo(),
            customerName,
            customerPhone,
            items: saleItems,
            subtotal: round2(subtotal),
            discountTotal: round2(discountTotal),
            gstTotal: round2(gstTotal),
            roundOff,
            grandTotal,
            paymentMode,
            tender,
            change: tender != null ? round2(Math.max(0, tender - grandTotal)) : 0,
            status: "completed",
            createdBy,
            createdByName,
          },
        ],
        { session },
      );
      sale = sale[0];
    });
    return Sale.findById(sale._id).populate("createdBy", "name email").lean();
  } finally {
    session.endSession();
  }
}

export async function voidSale(saleId, reason, userId, userName) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) throw ApiError.notFound("Sale not found");
      if (sale.status !== "completed")
        throw ApiError.badRequest("Only completed sales can be voided");

      // Restore stock to the batches.
      for (const item of sale.items) {
        const batch = await Batch.findById(item.batchId).session(session);
        if (!batch) continue;
        await removeStock({
          batchId: batch._id,
          locationType: null,
          rackCode: null,
          quantity: item.quantity,
          movementType: "Sales Outward",
          referenceDocId: sale._id,
          userId,
          userName,
          note: `Void sale ${sale.invoiceNo} - stock restored`,
        });
      }

      sale.status = "void";
      sale.voidReason = reason;
      await sale.save({ session });
      result = sale;
    });
    return result;
  } finally {
    session.endSession();
  }
}
