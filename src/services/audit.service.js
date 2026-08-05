import { AuditLog } from "../models/AuditLog.js";

export async function recordAudit({ userId, userName, action, entityType, entityId, details, ip }) {
  try {
    await AuditLog.create({
      userId,
      userName,
      action,
      entityType,
      entityId,
      details,
      ip,
    });
  } catch (err) {
    // Audit logging must never break the primary request.
    console.error(`[audit] failed to record: ${err.message}`);
  }
}
