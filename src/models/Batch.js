import { Schema, model } from "mongoose";

import { classifyBatchStatus } from "../utils/date.js";
import { constants } from "../config/constants.js";

const batchSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true, index: true },
    batchNumber: { type: String, required: true, trim: true, maxlength: 40 },
    mfgDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true, index: true },
    mrp: { type: Number, min: 0 },
    purchasePrice: { type: Number, min: 0 },
    sellingPrice: { type: Number, min: 0 },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", index: true },
    currentStock: { type: Number, min: 0, default: 0, index: true },
    status: {
      type: String,
      enum: constants.batchStatuses,
      default: "active",
      index: true,
    },
    locationType: { type: String, trim: true },
    rackCode: { type: String, trim: true, maxlength: 40 },
  },
  { timestamps: true },
);

batchSchema.index({ medicineId: 1, batchNumber: 1 }, { unique: true });

batchSchema.pre("save", function preSave(next) {
  if (this.expiryDate) {
    this.status = classifyBatchStatus(this.expiryDate, constants.expiry.nearExpiryDays);
  }
  next();
});

export const Batch = model("Batch", batchSchema);
