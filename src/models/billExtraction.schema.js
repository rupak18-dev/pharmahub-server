import { Schema } from "mongoose";

// OCR extraction metadata persisted on Purchase / Sale records created from an
// uploaded bill image. It is purely informational: totals are ALWAYS recomputed
// server-side on save, never trusted from the OCR.
//
// shape (mirrors the billExtraction service result):
//   source: "uploaded" | "manual"
//   status: "extracted" | "manual"       (manual = OCR could not read the doc)
//   documentType, confidence, warnings, rawOcrText, extractedAt
//   fields: { invoiceNumber, invoiceDate, supplier, party, items, totals... }
export const extractionSchema = new Schema(
  {
    source: { type: String, enum: ["uploaded", "manual"], default: "uploaded" },
    status: { type: String, enum: ["extracted", "manual"], default: "extracted" },
    documentType: { type: String, trim: true },
    confidence: { type: Number, min: 0, max: 100 },
    warnings: { type: [String], default: [] },
    rawOcrText: { type: String, maxlength: 40000 },
    extractedAt: { type: Date },
    fields: {
      type: new Schema(
        {
          invoiceNumber: { type: String },
          invoiceDate: { type: String },
          supplier: {
            type: new Schema(
              { name: String, gstin: String, address: String, phone: String, phones: [String] },
              { _id: false },
            ),
          },
          party: {
            type: new Schema({ name: String, gstin: String, phone: String }, { _id: false }),
          },
          customerPhone: { type: String },
          phoneCandidates: {
            type: [
              new Schema(
                {
                  number: String,
                  normalizedNumber: String,
                  confidence: { type: Number, min: 0, max: 99 },
                  source: String,
                  context: String,
                  role: { type: String, enum: ["supplier", "customer", "unknown"] },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
          items: { type: [Schema.Types.Mixed], default: [] },
          subtotal: { type: Number },
          discount: { type: Number },
          taxableAmount: { type: Number },
          totalSGST: { type: Number },
          totalCGST: { type: Number },
          gstTotal: { type: Number },
          printedGrandTotal: { type: Number },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false },
);
