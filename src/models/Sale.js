import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const saleItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true },
    medicineName: { type: String, trim: true },
    batchNumber: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discountPct: { type: Number, min: 0, max: 100, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    lineTotal: { type: Number, min: 0, required: true },
  },
  { _id: true },
);

const saleSchema = new Schema(
  {
    invoiceNo: { type: String, required: true, unique: true, trim: true },
    customerName: { type: String, trim: true, maxlength: 120 },
    customerPhone: { type: String, trim: true, maxlength: 30 },
    items: { type: [saleItemSchema], required: true },
    subtotal: { type: Number, min: 0, required: true },
    discountTotal: { type: Number, min: 0, default: 0 },
    gstTotal: { type: Number, min: 0, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, min: 0, required: true },
    paymentMode: { type: String, trim: true, default: "Cash" },
    tender: { type: Number, min: 0 },
    change: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: constants.saleStatuses,
      default: "completed",
      index: true,
    },
    voidReason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String },
  },
  { timestamps: true },
);

saleSchema.index({ createdAt: -1 });
saleSchema.index({ customerName: 1, createdAt: -1 });

export const Sale = model("Sale", saleSchema);
