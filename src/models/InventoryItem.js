import { Schema, model } from "mongoose";

import { constants } from "../config/constants.js";

const inventoryItemSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true, index: true },
    locationType: {
      type: String,
      enum: constants.locationTypes,
      default: "Front Shelf",
    },
    rackCode: { type: String, trim: true, maxlength: 40, index: true },
    quantityOnHand: { type: Number, min: 0, default: 0 },
    reservedQuantity: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

inventoryItemSchema.index({ batchId: 1, locationType: 1, rackCode: 1 }, { unique: true });

export const InventoryItem = model("InventoryItem", inventoryItemSchema);
