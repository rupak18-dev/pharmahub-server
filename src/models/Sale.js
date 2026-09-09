import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";
import { extractionSchema } from "./billExtraction.schema.js";

const saleItemSchema = new Schema(
  {
    // Optional for report-data bills (manual / uploaded / imported) that only
    // carry a medicine name and batch number. The POS always sets both refs.
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", default: null },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null },
    medicineName: { type: String, trim: true },
    batchNumber: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discountPct: { type: Number, min: 0, max: 100, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    // Server-computed per line so GST/discount history stays correct even if
    // the medicine's future GST configuration changes.
    taxableAmount: { type: Number, min: 0, default: 0 },
    gstAmount: { type: Number, min: 0, default: 0 },
    lineTotal: { type: Number, min: 0, required: true },
  },
  { _id: true },
);

const saleSchema = new Schema(
  {
    invoiceNo: { type: String, required: true, trim: true },
    customerName: { type: String, trim: true, maxlength: 120 },
    customerPhone: { type: String, trim: true, maxlength: 30 },
    items: { type: [saleItemSchema], required: true },
    subtotal: { type: Number, min: 0, required: true },
    discountTotal: { type: Number, min: 0, default: 0 },
    taxableAmount: { type: Number, min: 0, default: 0 },
    gstTotal: { type: Number, min: 0, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, min: 0, required: true },
    paymentMode: { type: String, trim: true, default: "Cash" },
    paymentStatus: {
      type: String,
      enum: ["paid", "pending", "partial"],
      default: "paid",
      index: true,
    },
    // Where this bill record came from. "existing" marks sales that came in
    // through the POS; the report-data workflow adds manual/uploaded/imported.
    source: {
      type: String,
      enum: ["manual", "uploaded", "imported", "existing"],
      default: "existing",
      index: true,
    },
    uploadedFile: {
      filename: { type: String, trim: true },
      path: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      size: { type: Number, min: 0 },
      _id: false,
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    // OCR metadata from the bill-upload flow (informational; totals are
    // recomputed server-side and never read from here).
    extraction: { type: extractionSchema, default: null },
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
saleSchema.index({ createdBy: 1, status: 1, createdAt: -1 });
// Ownership-aware duplicate protection: the same bill number can be reused
// across different pharmacies (or different days) without a global collision.
saleSchema.index({ createdBy: 1, invoiceNo: 1, createdAt: 1 });

export const Sale = model("Sale", saleSchema);
