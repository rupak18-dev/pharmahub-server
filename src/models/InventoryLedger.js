import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const inventoryLedgerSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true, index: true },
    movementType: { type: String, enum: constants.movementTypes, required: true },
    quantityChange: { type: Number, required: true },
    userId: { type: String, default: "system" },
    userName: { type: String },
    referenceDocId: { type: String },
    note: { type: String, trim: true },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

inventoryLedgerSchema.index({ batchId: 1, timestamp: -1 });

export const InventoryLedger = model("InventoryLedger", inventoryLedgerSchema);
