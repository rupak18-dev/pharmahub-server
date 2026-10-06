import { Schema, model } from "mongoose";

import { extractionSchema } from "./billExtraction.schema.js";

// Sources: how the record entered the Reports data store.
export const REPORT_BILL_SOURCES = ["manual", "uploaded", "imported", "existing"];

// Document type of the source document. Drives which report modules consume
// the record (sales-side types feed Sales/GST/Payments, the rest feed
// Purchases/GST/Suppliers).
export const REPORT_BILL_DOCUMENT_TYPES = [
  "purchase_invoice",
  "sales_invoice",
  "payment_receipt",
  "other",
];
export const REPORT_BILL_SALES_TYPES = ["sales_invoice"];
export const REPORT_BILL_PURCHASE_TYPES = ["purchase_invoice", "payment_receipt", "other"];

// Unified line item: both a sales-style unit price and a purchase-style rate
// are kept so one shape serves every report module. Only the relevant side is
// populated per record type.
const reportBillItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", default: null },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null },
    medicineName: { type: String, trim: true },
    quantity: { type: Number, min: 0, default: 0 },
    freeQuantity: { type: Number, min: 0, default: 0 },
    unitPrice: { type: Number, min: 0, default: null },
    unitCost: { type: Number, min: 0, default: null },
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

const originalDocumentSchema = new Schema(
  {
    filename: { type: String },
    path: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    uploadedAt: { type: Date },
  },
  { _id: false },
);

const reportBillSchema = new Schema(
  {
    source: { type: String, enum: REPORT_BILL_SOURCES, default: "manual", index: true },
    documentType: {
      type: String,
      enum: REPORT_BILL_DOCUMENT_TYPES,
      default: "purchase_invoice",
      index: true,
    },
    invoice: {
      invoiceNumber: { type: String, trim: true },
      invoiceDate: { type: Date },
    },
    supplier: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      gstin: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    customer: {
      name: { type: String, trim: true },
      gstin: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    items: { type: [reportBillItemSchema], default: [] },
    // Server-authoritative totals (recomputed on every write). Discount
    // REDUCES the taxable amount; grandTotal is rounded to the nearest rupee.
    totals: {
      subtotal: { type: Number, min: 0, default: 0 },
      discountAmount: { type: Number, min: 0, default: 0 },
      taxableAmount: { type: Number, min: 0, default: 0 },
      sgst: { type: Number, min: 0, default: 0 },
      cgst: { type: Number, min: 0, default: 0 },
      totalGst: { type: Number, min: 0, default: 0 },
      roundOff: { type: Number, default: 0 },
      grandTotal: { type: Number, min: 0, default: 0 },
      // For documents: the printed invoice total is the authoritative value
      // used by reports; the server-calculated total is kept alongside so the
      // two can be compared (amount-mismatch resolution in the review flow).
      printedGrandTotal: { type: Number, min: 0, default: null },
      calculatedGrandTotal: { type: Number, min: 0, default: null },
    },
    payment: {
      mode: { type: String, trim: true, default: "Cash" },
      status: { type: String, enum: ["paid", "pending", "partial"], default: "paid" },
    },
    status: { type: String, enum: ["completed", "received", "draft"], default: "received" },
    // The original uploaded document reference (path served from /uploads/bills).
    originalDocument: { type: originalDocumentSchema, default: null },
    // WhatsApp delivery state for the customer (sales bills). The bill itself is
    // always persisted; delivery is best-effort and tracked here for retries.
    whatsappDelivery: {
      status: {
        type: String,
        enum: ["not_attempted", "pending", "sent", "failed", "skipped"],
        default: "not_attempted",
      },
      // Why delivery was skipped (status "skipped"): "not_connected",
      // "server_not_configured", "no_number", "invalid_number".
      reason: { type: String, default: null },
      recipientPhone: { type: String, trim: true, default: null },
      messageId: { type: String, default: null },
      sentAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      skippedAt: { type: Date, default: null },
      errorCode: { type: String, default: null },
      errorMessage: { type: String, default: null },
      attempts: { type: Number, min: 0, default: 0 },
    },
    notes: { type: String, trim: true },
    // OCR metadata from the upload flow (informational; totals are recomputed
    // server-side and never read from here).
    extraction: { type: extractionSchema, default: null },
    // Org isolation follows the existing app model: a user belongs to one org
    // (denormalized orgName) and records are owner-scoped via createdBy.
    orgName: { type: String, trim: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    createdByName: { type: String },
  },
  { timestamps: true },
);

reportBillSchema.index({ createdBy: 1, createdAt: -1 });
reportBillSchema.index({ createdBy: 1, documentType: 1, createdAt: -1 });
reportBillSchema.index({ createdBy: 1, "invoice.invoiceNumber": 1, "invoice.invoiceDate": 1 });
reportBillSchema.index({ orgName: 1, createdAt: -1 });

export const ReportBill = model("ReportBill", reportBillSchema);
