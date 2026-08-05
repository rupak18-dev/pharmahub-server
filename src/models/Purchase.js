import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const purchaseItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch" },
    medicineName: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    quantityReceived: { type: Number, min: 0, default: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    lineTotal: { type: Number, min: 0, default: 0 },
  },
  { _id: true },
);

const purchaseSchema = new Schema(
  {
    orderNo: { type: String, required: true, unique: true, trim: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    items: { type: [purchaseItemSchema], required: true },
    subtotal: { type: Number, min: 0, default: 0 },
    discount: { type: Number, min: 0, default: 0 },
    gstTotal: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: constants.purchaseStatuses,
      default: "draft",
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

export const Purchase = model("Purchase", purchaseSchema);
