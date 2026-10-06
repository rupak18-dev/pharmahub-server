import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";
import { extractionSchema } from "./billExtraction.schema.js";

// Document type of the source document. With no OCR provider the type is
// chosen by the user during review; it drives nothing structurally here.
export const PURCHASE_DOCUMENT_TYPES = [
  "purchase_invoice",
  "sales_invoice",
  "payment_receipt",
  "other",
];
export const PURCHASE_SOURCES = ["manual", "uploaded", "imported", "existing"];

const purchaseItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", default: null },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null },
    medicineName: { type: String, trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    quantityReceived: { type: Number, min: 0, default: 0 },
    freeQuantity: { type: Number, min: 0, default: 0 },
    // Rate charged by the supplier (the legacy field name is unitCost; it now
    // also carries invoice "rate" for documents that were not POS orders).
    unitCost: { type: Number, min: 0, default: 0 },
    mrp: { type: Number, min: 0, default: 0 },
    discountPct: { type: Number, min: 0, max: 100, default: 0 },
    discountAmount: { type: Number, min: 0, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    sgstRate: { type: Number, min: 0, max: 100, default: 0 },
    cgstRate: { type: Number, min: 0, max: 100, default: 0 },
    sgstAmount: { type: Number, min: 0, default: 0 },
    cgstAmount: { type: Number, min: 0, default: 0 },
    gstAmount: { type: Number, min: 0, default: 0 },
    taxableAmount: { type: Number, min: 0, default: 0 },
    lineTotal: { type: Number, min: 0, default: 0 },
    hsnCode: { type: String, trim: true },
    pack: { type: String, trim: true },
    batchNumber: { type: String, trim: true },
    expiryDate: { type: Date },
    manufacturer: { type: String, trim: true },
  },
  { _id: true },
);

const partySchema = new Schema(
  {
    name: { type: String, trim: true },
    gstin: { type: String, trim: true },
  },
  { _id: false },
);

const purchaseSchema = new Schema(
  {
    // orderNo doubles as the invoice number for uploaded documents. It is NOT
    // globally unique (each pharmacy owns its numbering); duplicate protection
    // is createdBy + orderNo + calendar day, mirroring sales bills.
    orderNo: { type: String, required: true, trim: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    // Snapshot so reports work even when no Supplier record was created for an
    // uploaded invoice (reports read supplierId.name || supplierName).
    supplierName: { type: String, trim: true },
    party: { type: partySchema, default: () => ({}) },
    items: { type: [purchaseItemSchema], required: true },
    subtotal: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, default: 0 },
    taxableAmount: { type: Number, min: 0, default: 0 },
    gstTotal: { type: Number, min: 0, default: 0 },
    totalSGST: { type: Number, min: 0, default: 0 },
    totalCGST: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0, default: 0 },
    // For documents: the printed invoice total is the authoritative value used
    // by reports; the server-calculated total is kept separately so the two can
    // be compared (amount-mismatch resolution in the review flow).
    printedGrandTotal: { type: Number, min: 0, default: null },
    calculatedGrandTotal: { type: Number, min: 0, default: null },
    // Nearest-rupee adjustment and can be negative (e.g. -0.18), matching Sale.
    roundOff: { type: Number, default: 0 },
    status: {
      type: String,
      enum: constants.purchaseStatuses,
      default: "draft",
      index: true,
    },
    documentType: { type: String, enum: PURCHASE_DOCUMENT_TYPES, default: "purchase_invoice" },
    source: { type: String, enum: PURCHASE_SOURCES, default: "existing" },
    originalDocument: {
      type: new Schema(
        {
          filename: { type: String },
          path: { type: String },
          mimeType: { type: String },
          size: { type: Number },
          uploadedAt: { type: Date },
        },
        { _id: false },
      ),
      default: null,
    },
    notes: { type: String, trim: true },
    // OCR metadata from the bill-upload flow (informational; totals are
    // recomputed server-side and never read from here).
    extraction: { type: extractionSchema, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    createdByName: { type: String },
    orderedAt: { type: Date },
    receivedAt: { type: Date },
  },
  { timestamps: true },
);

purchaseSchema.index({ createdBy: 1, orderNo: 1, createdAt: 1 });

export const Purchase = model("Purchase", purchaseSchema);
