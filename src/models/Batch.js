import { randomUUID } from "node:crypto";

import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const movementSchema = new Schema(
  {
    id: { type: String, default: () => randomUUID() },
    type: { type: String, required: true },
    note: { type: String, trim: true, maxlength: 300 },
    qty: { type: Number, min: 0, default: 0 },
    timestamp: { type: Date, default: Date.now },
    from: { type: String },
    to: { type: String },
    by: { type: String },
  },
  { _id: false },
);

const batchSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", index: true },
    batchNumber: { type: String, required: true, trim: true, maxlength: 40 },
    batchType: { type: String, enum: ["C", "L", "V"], default: "C" },
    dates: {
      manufacturingDate: { type: Date, required: true },
      expiryDate: { type: Date, required: true, index: true },
      quarantineUntil: { type: Date, default: null },
    },
    pricing: {
      purchasePrice: { type: Number, min: 0, default: 0 },
      mrp: { type: Number, min: 0, default: 0 },
      sellingPrice: { type: Number, min: 0, default: 0 },
      gstRate: { type: Number, min: 0, default: 0 },
    },
    status: {
      isRecalled: { type: Boolean, default: false },
      state: {
        type: String,
        enum: ["ACTIVE", "QUARANTINED", "RECALLED", "BLOCKED", "RETIRED"],
        default: "ACTIVE",
      },
      quarantineReason: { type: String, default: null },
    },
    stock: {
      uom: { type: String, default: "Units" },
      quantityOnHand: { type: Number, min: 0, default: 0 },
      reservedQuantity: { type: Number, min: 0, default: 0 },
      quarantined: { type: Number, min: 0, default: 0 },
    },
    warehouse: {
      locationType: { type: String, enum: constants.locationTypes, default: "Front Shelf" },
      rackCode: { type: String, trim: true, default: "" },
    },
    audit: {
      createdAt: { type: Date },
      updatedAt: { type: Date },
      updatedBy: { type: String },
    },
    version: { type: Number, default: 1 },
    movements: { type: [movementSchema], default: [] },
  },
  { timestamps: true },
);

batchSchema.index({ medicineId: 1, batchNumber: 1 }, { unique: true });

export const Batch = model("Batch", batchSchema);
