import { Schema, model } from "mongoose";

const stockMovementSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true, index: true },
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", index: true },
    movementType: {
      type: String,
      enum: ["in", "out", "adjustment"],
      required: true,
    },
    quantity: { type: Number, required: true },
    reason: { type: String, trim: true },
    referenceDocId: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String },
  },
  { timestamps: true },
);

stockMovementSchema.index({ medicineId: 1, createdAt: -1 });

export const StockMovement = model("StockMovement", stockMovementSchema);
