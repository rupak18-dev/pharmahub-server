import { Schema, model } from "mongoose";

const notificationSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    type: {
      type: String,
      enum: ["expiry", "low_stock", "system", "purchase", "sale", "audit"],
      default: "system",
      index: true,
    },
    entityType: { type: String },
    entityId: { type: String },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const Notification = model("Notification", notificationSchema);
