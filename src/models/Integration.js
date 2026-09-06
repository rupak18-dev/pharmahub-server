import { Schema, model } from "mongoose";

const integrationSchema = new Schema(
  {
    key: { type: String, required: true, index: true },
    name: { type: String, required: true },
    connected: { type: Boolean, default: false },
    configured: { type: Boolean, default: false },
    config: { type: Schema.Types.Mixed, default: {} },
    lastSync: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

export const Integration = model("Integration", integrationSchema);
