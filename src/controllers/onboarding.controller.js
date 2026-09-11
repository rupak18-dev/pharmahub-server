import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import { logger } from "../core/logger.js";
import { getOnboarding, upsertOnboarding } from "../services/onboarding.service.js";
import { User } from "../models/User.js";
import { Role } from "../models/Role.js";
import { sendEmail } from "../services/email.service.js";
import { buildWelcomeEmail } from "../services/emailTemplates.js";
import { env } from "../config/env.js";

export const get = asyncHandler(async (req, res) => {
  const data = await getOnboarding(req.user._id);
  return ok(res, data, "Onboarding data");
});

export const save = asyncHandler(async (req, res) => {
  const data = await upsertOnboarding(req.user._id, req.body);
  const dataObj = data?.toObject ? data.toObject() : data;
  const personal = req.body?.personal || dataObj?.personal || {};
  const workspace = req.body?.workspace || dataObj?.workspace || {};
  const businessType = req.body?.businessType || dataObj?.businessType;

  // Completion signal: the wizard payload carries `onboarded: true`. Persist
  // the flag on the User (the frontend relies on it for routing), and adopt
  // the selected job title as the account's role. roleId links to the system
  // Role record when one exists so effective permissions resolve; custom
  // titles stay stored as the raw string.
  if (req.body.onboarded) {
    const update = { onboarded: true };
    const jobTitle = personal?.jobTitle?.trim();
    if (jobTitle) {
      const roleDoc = await Role.findOne({ name: jobTitle }).select("_id").lean();
      update.role = jobTitle;
      update.roleId = roleDoc ? roleDoc._id : null;
    }
    // Only an establishing account adopts the wizard's organization — never
    // overwrite an org assigned via invitation or by the Owner.
    const orgName = workspace?.organizationName?.trim();
    if (!req.user.orgName && orgName) update.orgName = orgName;

    const firstName = personal?.firstName?.trim();
    const lastName = personal?.lastName?.trim();
    if (firstName && lastName) {
      update.name = `${firstName} ${lastName}`.trim();
    }
    const phone = personal?.phone?.trim();
    if (phone) update.phone = phone;

    if (businessType) update.businessType = businessType;
    if (workspace?.gstNumber?.trim()) update.gstin = workspace.gstNumber.trim();
    if (workspace?.drugLicenseNumber?.trim()) update.licenseNo = workspace.drugLicenseNumber.trim();
    if (workspace?.branchName?.trim()) {
      update.branches = [workspace.branchName.trim()];
      if (!update.address) update.address = workspace.branchName.trim();
    }

    await User.findByIdAndUpdate(req.user._id, { $set: update });
    logger.info(
      `[onboarding.save] userId=${req.user._id} onboarded=true role=${update.role ?? "(unchanged)"} roleId=${update.roleId ?? null} org=${update.orgName ?? req.user.orgName ?? "(none)"}`,
    );

    // First time the wizard completes: send the welcome email. Fire-and-forget —
    // a delivery failure must never block or break onboarding, and repeating
    // saves with `onboarded: true` must not send a second welcome.
    if (!req.user.onboarded) {
      const recipientName = (personal?.firstName?.trim() ||
        req.user?.name) ||
        "there";
      const { subject, html, text } = buildWelcomeEmail({
        name: recipientName,
        getStartedUrl: `${env.frontendUrl}/dashboard`,
      });
      sendEmail({
        to: req.user?.email,
        subject,
        html,
        text,
      })
        .then(() => {
          logger.info(
            `[welcomeEmail] sent to ${req.user?.email} for userId=${req.user._id}`,
          );
        })
        .catch((error) => {
          logger.warn(
            `[welcomeEmail] delivery failed for userId=${req.user._id} email=${req.user?.email}: ${error.message}`,
          );
        });
    }
  }
  return ok(res, data, "Onboarding data saved");
});

