import { Schema, model } from "mongoose";

const integrationSchema = new Schema(
  {
    key: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    tenantId: { type: String, required: true, index: true },
    orgName: { type: String, default: "" },
    connected: { type: Boolean, default: false },
    configured: { type: Boolean, default: false },
    config: { type: Schema.Types.Mixed, default: {} },
    lastSync: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    accountEmail: { type: String, default: null },
    tokens: { type: Schema.Types.Mixed, select: false },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

integrationSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const Integration = model("Integration", integrationSchema);
