import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const purchaseItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch" },
    medicineName: { type: String, trim: true },
    genericName: { type: String, trim: true },
    batchNumber: { type: String, trim: true },
    mfgDate: { type: Date },
    expiryDate: { type: Date },
    mrp: { type: Number, min: 0, default: 0 },
    ptr: { type: Number, min: 0, default: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 0 },
    freeQty: { type: Number, min: 0, default: 0 },
    schemeAmt: { type: Number, min: 0, default: 0 },
    discPct: { type: Number, min: 0, max: 100, default: 0 },
    baseAmt: { type: Number, min: 0, default: 0 },
    quantityReceived: { type: Number, min: 0, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    lineTotal: { type: Number, min: 0, default: 0 },
  },
  { _id: true },
);

const purchaseSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true, trim: true, index: true },
    invoiceNumber: { type: String, trim: true, index: true },
    invoiceDate: { type: Date },
    dueDate: { type: Date },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    poId: { type: String, trim: true },
    paymentType: {
      type: String,
      enum: ["cash", "upi", "card", "netbanking", "credit"],
      default: "cash",
    },
    paymentStatus: {
      type: String,
      enum: ["paid", "pending", "partial"],
      default: "paid",
    },
    amountPaid: { type: Number, min: 0, default: 0 },
    paymentTxnRef: { type: String, trim: true },
    lifaMode: { type: String, enum: ["LIFA", "LILA"], default: "LIFA" },
    items: { type: [purchaseItemSchema], required: true },
    subtotal: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, default: 0 },
    gstTotal: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: constants.purchaseStatuses,
      default: "received",
      index: true,
    },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String },
    orderedAt: { type: Date },
    receivedAt: { type: Date },
  },
  { timestamps: true },
);

purchaseSchema.index({ invoiceNumber: "text", orderNo: "text", createdByName: "text" });

export const Purchase = model("Purchase", purchaseSchema);

