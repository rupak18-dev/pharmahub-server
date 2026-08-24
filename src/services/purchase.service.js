import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { Medicine } from "../models/Medicine.js";
import { Purchase } from "../models/Purchase.js";
import { Supplier } from "../models/Supplier.js";
import { addStock } from "./inventory.service.js";
import { generateNumericId } from "../utils/id.js";
import { round2 } from "../utils/date.js";

/**
 * Creates a purchase order or direct received purchase bill (GRN).
 */
export async function createPurchaseOrder(payload) {
  const {
    supplierId,
    orderNo: customOrderNo,
    invoiceNumber,
    invoiceDate,
    dueDate,
    poId,
    paymentType = "cash",
    paymentStatus = "paid",
    amountPaid = 0,
    paymentTxnRef,
    lifaMode = "LIFA",
    items,
    discount = 0,
    notes,
    status = "received",
    createdBy,
    createdByName,
  } = payload;

  // Resolve supplier: accept ID or lookup by name/fallback
  let resolvedSupplier = null;
  if (mongoose.isValidObjectId(supplierId)) {
    resolvedSupplier = await Supplier.findById(supplierId);
  }
  if (!resolvedSupplier) {
    resolvedSupplier = await Supplier.findOne({
      $or: [{ name: supplierId }, { _id: supplierId }],
    });
  }
  if (!resolvedSupplier) {
    resolvedSupplier = await Supplier.findOne();
  }

  const effectiveSupplierId = resolvedSupplier ? resolvedSupplier._id : supplierId;

  // Resolve medicines
  const medicineIds = items
    .map((i) => i.medicineId)
    .filter((id) => mongoose.isValidObjectId(id));
  const meds = await Medicine.find({ _id: { $in: medicineIds } }).lean();
  const medMap = new Map(meds.map((m) => [String(m._id), m]));

  const orderItems = [];
  const stockAdditions = [];

  for (const item of items) {
    let med = medMap.get(String(item.medicineId));
    if (!med && !mongoose.isValidObjectId(item.medicineId)) {
      med = await Medicine.findOne({ name: item.medicineName || item.medicineId });
    }

    const medId = med ? med._id : (mongoose.isValidObjectId(item.medicineId) ? item.medicineId : (meds[0]?._id ?? new mongoose.Types.ObjectId()));
    const medName = item.medicineName || med?.name || "Unknown Medicine";
    const unitCost = Number(item.unitCost ?? item.ptr ?? 100);
    const qty = Number(item.quantity || 1);
    const freeQty = Number(item.freeQty || 0);
    const schemeAmt = Number(item.schemeAmt || 0);
    const discPct = Number(item.discPct || 0);
    const gstRate = Number(item.gstRate ?? med?.gstRate ?? 12);

    const rawBase = unitCost * qty - schemeAmt;
    const discountVal = (rawBase * discPct) / 100;
    const baseAmt = Math.max(0, round2(rawBase - discountVal));
    const lineTotal = round2(baseAmt * (1 + gstRate / 100));

    const batchNum = item.batchNumber || `BTH-${generateNumericId(6)}`;
    const mfgDate = item.mfgDate ? new Date(item.mfgDate) : new Date();
    let expDate;
    if (item.expiryDate) {
      const expStr = String(item.expiryDate);
      expDate = new Date(expStr.length === 7 ? `${expStr}-28` : expStr);
    } else {
      expDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    const mrp = Number(item.mrp || round2(unitCost * 1.25));
    const sellingPrice = Number(item.sellingPrice || round2(mrp * 0.95));

    let batchId = item.batchId;

    // If status is 'received' or direct bill, create or update batch in MongoDB
    if (status === "received" || status === "partially_received") {
      let batch = await Batch.findOne({
        medicineId: medId,
        batchNumber: batchNum,
      });

      const totalReceivedQty = qty + freeQty;

      if (batch) {
        batch.pricing.purchasePrice = unitCost;
        batch.pricing.mrp = mrp;
        batch.pricing.sellingPrice = sellingPrice;
        batch.pricing.gstRate = gstRate;
        batch.dates.expiryDate = expDate;
        batch.dates.manufacturingDate = mfgDate;
        await batch.save();
      } else {
        batch = await Batch.create({
          medicineId: medId,
          supplierId: effectiveSupplierId,
          batchNumber: batchNum,
          batchType: "C",
          dates: {
            manufacturingDate: mfgDate,
            expiryDate: expDate,
          },
          pricing: {
            purchasePrice: unitCost,
            mrp,
            sellingPrice,
            gstRate,
          },
          status: { state: "ACTIVE" },
          stock: {
            uom: "Units",
            quantityOnHand: 0,
            reservedQuantity: 0,
            quarantined: 0,
          },
          warehouse: {
            locationType: item.locationType || "Front Shelf",
            rackCode: item.rackCode || "UNASSIGNED",
          },
          audit: {
            createdAt: new Date(),
            updatedAt: new Date(),
            updatedBy: createdByName || "Purchases",
          },
          version: 1,
        });
      }

      batchId = batch._id;

      stockAdditions.push({
        batchId: batch._id,
        locationType: item.locationType || "Front Shelf",
        rackCode: item.rackCode || "UNASSIGNED",
        quantity: totalReceivedQty,
        note: `Purchase Bill ${invoiceNumber || customOrderNo || ""}`,
      });
    }

    orderItems.push({
      medicineId: medId,
      batchId: mongoose.isValidObjectId(batchId) ? batchId : undefined,
      medicineName: medName,
      genericName: item.genericName || med?.genericName,
      batchNumber: batchNum,
      mfgDate,
      expiryDate: expDate,
      mrp,
      ptr: unitCost,
      unitCost,
      quantity: qty,
      freeQty,
      schemeAmt,
      discPct,
      baseAmt,
      gstRate,
      lineTotal,
      quantityReceived: status === "received" ? qty + freeQty : 0,
    });
  }

  const calculatedSubtotal = round2(orderItems.reduce((s, i) => s + (i.baseAmt || (i.unitCost * i.quantity)), 0));
  const calculatedGstTotal = round2(
    orderItems.reduce((s, i) => s + (i.baseAmt || (i.unitCost * i.quantity)) * (i.gstRate / 100), 0),
  );
  const calculatedGrandTotal = round2(calculatedSubtotal - discount + calculatedGstTotal);

  const finalOrderNo = customOrderNo || (status === "received" ? `GRN-${Date.now().toString().slice(-6)}` : `PO-${Date.now().toString().slice(-8)}-${generateNumericId(3)}`);
  const finalInvoiceNumber = invoiceNumber || `INV-${generateNumericId(6)}`;

  const purchaseDoc = await Purchase.create({
    orderNo: finalOrderNo,
    invoiceNumber: finalInvoiceNumber,
    invoiceDate: invoiceDate ? new Date(invoiceDate) : new Date(),
    dueDate: dueDate ? new Date(dueDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    supplierId: effectiveSupplierId,
    poId,
    paymentType,
    paymentStatus,
    amountPaid: Number(amountPaid) || calculatedGrandTotal,
    paymentTxnRef,
    lifaMode,
    items: orderItems,
    subtotal: calculatedSubtotal,
    discount,
    gstTotal: calculatedGstTotal,
    grandTotal: calculatedGrandTotal,
    status,
    notes,
    createdBy: mongoose.isValidObjectId(createdBy) ? createdBy : undefined,
    createdByName,
    orderedAt: new Date(),
    receivedAt: status === "received" ? new Date() : undefined,
  });

  // Apply stock additions
  for (const addition of stockAdditions) {
    await addStock({
      batchId: addition.batchId,
      locationType: addition.locationType,
      rackCode: addition.rackCode,
      quantity: addition.quantity,
      referenceDocId: String(purchaseDoc._id),
      userId: createdBy,
      userName: createdByName,
      note: addition.note,
    });
  }

  return Purchase.findById(purchaseDoc._id)
    .populate("supplierId", "name contactInfo phone email")
    .populate("items.medicineId", "name genericName brandName");
}

/**
 * Finds a purchase by ID, orderNo, or invoiceNumber
 */
export async function findPurchaseByIdOrNumber(query) {
  if (!query) return null;
  const q = String(query).trim();

  let purchase = null;
  if (mongoose.isValidObjectId(q)) {
    purchase = await Purchase.findById(q)
      .populate("supplierId", "name contactInfo phone email")
      .populate("items.medicineId", "name genericName brandName");
  }

  if (!purchase) {
    purchase = await Purchase.findOne({
      $or: [
        { invoiceNumber: { $regex: new RegExp(`^${q}$`, "i") } },
        { orderNo: { $regex: new RegExp(`^${q}$`, "i") } },
      ],
    })
      .populate("supplierId", "name contactInfo phone email")
      .populate("items.medicineId", "name genericName brandName");
  }

  return purchase;
}

export async function receivePurchase(purchaseId, { items }, userId, userName) {
  const purchase = await Purchase.findById(purchaseId);
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

    let batch = await Batch.findOne({
      medicineId: item.medicineId,
      batchNumber: incoming.batchNumber,
    });

    if (batch) {
      batch.pricing.purchasePrice = item.unitCost;
      if (incoming.mrp != null) batch.pricing.mrp = incoming.mrp;
      if (incoming.sellingPrice != null) batch.pricing.sellingPrice = incoming.sellingPrice;
      if (incoming.expiryDate) batch.dates.expiryDate = incoming.expiryDate;
      await batch.save();
    } else {
      batch = await Batch.create({
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
        audit: {
          createdAt: new Date(),
          updatedAt: new Date(),
          updatedBy: userName || "Purchases",
        },
        version: 1,
      });
    }

    await addStock({
      batchId: batch._id,
      locationType: incoming.locationType ?? "Front Shelf",
      rackCode: incoming.rackCode ?? "UNASSIGNED",
      quantity: incoming.quantityReceived,
      referenceDocId: String(purchase._id),
      userId,
      userName,
      note: `GRN for ${purchase.orderNo}`,
    });

    item.batchId = batch._id;
  }

  purchase.status = allReceived ? "received" : "partially_received";
  purchase.receivedAt = new Date();
  await purchase.save();

  return {
    purchase: await Purchase.findById(purchaseId).populate("supplierId"),
    allReceived,
  };
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
