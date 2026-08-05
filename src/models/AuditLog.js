import { Schema, model } from "mongoose";

const auditLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    userName: { type: String },
    action: { type: String, required: true, trim: true },
    entityType: { type: String, trim: true, index: true },
    entityId: { type: String },
    details: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

export const AuditLog = model("AuditLog", auditLogSchema);
