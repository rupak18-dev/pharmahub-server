import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok } from "../core/responses.js";
import { SupportSetting } from "../models/SupportSetting.js";
import { recordAudit } from "../services/audit.service.js";

/**
 * GET /api/v1/support/settings
 * Read-only global support configuration for all users (public / optionalAuth).
 */
export const getSupportSettings = asyncHandler(async (_req, res) => {
  let settings = await SupportSetting.findOne({ key: "global" }).lean();

  if (!settings) {
    // Initialize default global settings if not present
    settings = await SupportSetting.create({ key: "global" });
  }

  return ok(res, settings, "Global support settings");
});

/**
 * PUT /api/v1/support/settings
 * Update global support customization.
 * Strictly protected: Admin or Owner role only.
 */
export const updateSupportSettings = asyncHandler(async (req, res) => {
  const isDedicatedAdmin =
    req.user &&
    req.user.email?.toLowerCase().trim() === "pharmahub.team@gmail.com";

  if (!isDedicatedAdmin) {
    throw ApiError.forbidden("Only the dedicated Admin Support account (pharmahub.team@gmail.com) can customize global Support settings");
  }

  const {
    title,
    description,
    supportEmail,
    supportPhone,
    slaText,
    helpInfo,
    categories,
  } = req.body;

  const updateFields = {
    updatedBy: req.user._id,
    updatedByName: req.user.name || "Admin Support",
  };

  if (typeof title === "string" && title.trim()) {
    updateFields.title = title.trim();
  }
  if (typeof description === "string") {
    updateFields.description = description.trim();
  }
  if (typeof supportEmail === "string" && supportEmail.trim()) {
    updateFields.supportEmail = supportEmail.trim().toLowerCase();
  }
  if (typeof supportPhone === "string" && supportPhone.trim()) {
    updateFields.supportPhone = supportPhone.trim();
  }
  if (typeof slaText === "string") {
    updateFields.slaText = slaText.trim();
  }
  if (typeof helpInfo === "string") {
    updateFields.helpInfo = helpInfo.trim();
  }
  if (Array.isArray(categories)) {
    updateFields.categories = categories
      .filter((c) => c && typeof c.id === "string" && typeof c.label === "string")
      .map((c) => ({
        id: c.id.trim(),
        label: c.label.trim(),
        icon: c.icon || "💬",
        desc: c.desc || "",
      }));
  }

  const updatedSettings = await SupportSetting.findOneAndUpdate(
    { key: "global" },
    { $set: updateFields },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  recordAudit({
    userId: req.user._id,
    userName: req.user.name,
    action: "Updated global support settings",
    entityType: "support_settings",
    entityId: updatedSettings._id,
    details: updateFields,
    ip: req.ip,
  });

  return ok(res, updatedSettings, "Support settings updated successfully");
});
