import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created } from "../core/responses.js";
import { logger } from "../core/logger.js";
import { buildPagination, paginationMeta } from "../utils/pagination.js";
import { User } from "../models/User.js";
import { Invitation } from "../models/Invitation.js";
import { Role } from "../models/Role.js";
import { recordAudit } from "../services/audit.service.js";
import { toPublicUser, issueToken, toAuthUser } from "../services/auth.service.js";
import { sendEmail } from "../services/mailer.js";
import {
  buildInvitationEmail,
  buildRoleChangeEmail,
  buildStaffRemovalEmail,
} from "../services/emailTemplates.js";
import {
  saveProfileCompletion,
  computeProfileCompletion,
} from "../services/profileCompletion.service.js";
import {
  sanitizePermissionOverrides,
  normalizePermissions,
  getEffectivePermissions,
} from "../services/permissions.service.js";
import { deleteStoredFile } from "../middlewares/upload.js";
import { env } from "../config/env.js";
import { constants } from "../config/constants.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const PROFILE_EDITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "orgName",
  "tagline",
  "description",
  "businessEmail",
  "website",
  "address",
  "city",
  "state",
  "pincode",
  "gstin",
  "licenseNo",
  "businessType",
  "services",
  "businessHours",
  "metaPixelId",
  "branches",
  "onboarded",
];

async function assertRoleExists(role) {
  if (!role) return;
  const found = await Role.findOne({ name: role }).lean();
  if (!found) throw ApiError.badRequest(`Role "${role}" does not exist`);
}

// Resolve the Role record id for a role name (null when unknown). Stored on
// users/invitations as roleId so custom roles persist across refresh/re-login.
async function resolveRoleId(role) {
  if (!role) return null;
  const found = await Role.findOne({ name: role }).select("_id").lean();
  return found?._id ?? null;
}

// Keep only known modules so arbitrary keys can never sneak into the whitelist.
function sanitizeAccessModules(accessIds) {
  if (!Array.isArray(accessIds)) return [];
  const allowed = new Set(constants.accessModules);
  return [...new Set(accessIds.map((m) => String(m).trim()).filter((m) => allowed.has(m)))];
}

function sameStringArray(a, b) {
  const norm = (arr) => [...new Set((arr ?? []).map((x) => String(x).trim()))].sort();
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// Deep-normalize a value (Maps / Mongoose subdocuments / arrays / objects) into
// a stable, key-sorted JSON structure so two states can be compared exactly.
function normalizeComparable(value) {
  if (value instanceof Map) return normalizeComparable(Object.fromEntries(value));
  if (value && typeof value.toObject === "function") return normalizeComparable(value.toObject());
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalizeComparable(value[key]);
    return out;
  }
  return value;
}

function submittedDiffers(submitted, stored) {
  const sub = normalizeComparable(submitted ?? {});
  const store = normalizeComparable(stored ?? {});
  const allKeys = new Set([...Object.keys(sub), ...Object.keys(store)]);
  for (const key of allKeys) {
    const a = JSON.stringify(sub[key]);
    const b = JSON.stringify(normalizeComparable(store[key]));
    if (a !== b) return true;
  }
  return false;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function assertSameOrganization(invitation, caller) {
  if (caller.role === "Owner") return;
  if (String(invitation.invitedBy) === String(caller._id)) return;
  if (
    invitation.orgName &&
    caller.orgName &&
    invitation.orgName.toLowerCase() === caller.orgName.toLowerCase()
  )
    return;
  if (!invitation.orgName || !caller.orgName) return;
  throw ApiError.forbidden("You can only manage invitations from your own organization");
}

// Cross-organization isolation: users are scoped to their denormalized orgName.
// Callers without an org (rare dev/legacy records) may manage org-less users.
function assertSameOrgOrAllow(target, caller) {
  if (caller?.role === "Owner") return;
  if (!target.orgName) return;
  if (!caller?.orgName) return;
  if (target.orgName.toLowerCase() !== caller.orgName.toLowerCase()) {
    throw ApiError.forbidden("You can only manage users from your own organization");
  }
}

export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  logger.info(
    `[users.list] GET /users — user=${req.user.email} org=${req.user.orgName ?? "(none)"}`,
  );

  const filter = {};
  if (req.query.active !== undefined) filter.active = req.query.active === "true";
  if (req.query.role) filter.role = req.query.role;
  if (req.query.status) filter.status = req.query.status;
  if (req.user.orgName && req.user.role !== "Owner") {
    filter.orgName = new RegExp(
      `^${req.user.orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
  }
  // Removed users are hidden from the default list; use ?includeRemoved=true
  // to audit removals explicitly.
  if (!req.query.includeRemoved && !filter.status) {
    filter.status = { $ne: "removed" };
  }
  if (req.query.search) {
    const re = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: re }, { email: re }];
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  return ok(res, users.map(toPublicUser), "Users", paginationMeta(total, { page, limit }));
});

export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).lean();
  if (!user) throw ApiError.notFound("User not found");
  assertSameOrgOrAllow(user, req.user);
  return ok(res, toPublicUser(user));
});

// GET /users/me — returns the signed-in user's full profile + completion +
// effective permissions. Registered before /:id so "me" is never treated as an
// ObjectId. This is the primary auth hydration endpoint used by the frontend.
export const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  const publicUser = await toAuthUser(user);
  publicUser.profileCompletion = computeProfileCompletion(user);
  return ok(res, publicUser);
});

// PUT /users/me/profile — persists allowed profile fields and recalculates the
// completion score server-side. Role, permissions, active and passwordHash are
// deliberately NOT in the whitelist and can never be written here.
export const updateMyProfile = asyncHandler(async (req, res) => {
  const updatePayload = {};
  for (const key of Object.keys(req.body)) {
    if (PROFILE_EDITABLE_FIELDS.includes(key)) updatePayload[key] = req.body[key];
  }
  if (Object.keys(updatePayload).length === 0) {
    throw ApiError.badRequest("No editable profile fields provided");
  }

  if (updatePayload.email !== undefined) {
    const normalized = updatePayload.email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalized, _id: { $ne: req.user._id } });
    if (existing) throw ApiError.conflict("A user with this email already exists");
    updatePayload.email = normalized;
  }
  if (updatePayload.branches !== undefined && !Array.isArray(updatePayload.branches)) {
    updatePayload.branches = [updatePayload.branches].filter(Boolean);
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound("User not found");
  Object.assign(user, updatePayload);

  const completion = await saveProfileCompletion(user);

  recordAudit({
    userId: user._id,
    userName: user.name,
    action: "Profile updated",
    entityType: "user",
    entityId: String(user._id),
    ip: req.ip,
  });

  return ok(
    res,
    { user: toPublicUser(user.toObject()), profileCompletion: completion },
    "Profile updated",
  );
});

// PUT /users/me/avatar — multipart profile-image upload. The authenticated
// identity (req.user) is the only source of truth for the target user; the
// client can never choose whose avatar is being written. The file is stored
// on disk and only a permanent /uploads/... URL is persisted in MongoDB.
export const updateAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("No image file provided");

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound("User not found");

  const previous = user.avatarUrl;
  user.avatarUrl = `/uploads/profile/${req.file.filename}`;
  const completion = await saveProfileCompletion(user);

  // Only remove the previous file after the new one is safely persisted.
  deleteStoredFile(previous);

  recordAudit({
    userId: user._id,
    userName: user.name,
    action: "Profile image updated",
    entityType: "user",
    entityId: String(user._id),
    ip: req.ip,
  });

  return ok(
    res,
    { user: toPublicUser(user.toObject()), profileCompletion: completion },
    "Profile image updated",
  );
});

// DELETE /users/me/avatar — removes the stored file and clears the reference
// so the default avatar/initials render everywhere.
export const removeAvatar = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound("User not found");

  deleteStoredFile(user.avatarUrl);
  user.avatarUrl = null;
  const completion = await saveProfileCompletion(user);

  recordAudit({
    userId: user._id,
    userName: user.name,
    action: "Profile image removed",
    entityType: "user",
    entityId: String(user._id),
    ip: req.ip,
  });

  return ok(
    res,
    { user: toPublicUser(user.toObject()), profileCompletion: completion },
    "Profile image removed",
  );
});

export const createUser = asyncHandler(async (req, res) => {
  await assertRoleExists(req.body.role);
  const existing = await User.findOne({ email: req.body.email.toLowerCase() }).collation({
    locale: "en",
    strength: 2,
  });
  if (existing) throw ApiError.conflict("A user with this email already exists");
  const passwordHash = await bcrypt.hash(req.body.password, 10);
  const roleId = await resolveRoleId(req.body.role);
  const user = await User.create({
    ...req.body,
    roleId,
    email: req.body.email.toLowerCase(),
    passwordHash,
  });
  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "User created",
    entityType: "user",
    entityId: user._id,
    ip: req.ip,
  });
  return created(res, toPublicUser(user.toObject()), "User created");
});

export const updateUser = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw ApiError.notFound("User not found");
  assertSameOrgOrAllow(target, req.user);

  // Only allow safe fields to be updated via PATCH
  const {
    name,
    role,
    active,
    phone,
    email,
    status,
    permissions,
    featureAccess,
    accessIds,
    department,
    designation,
  } = req.body;
  const roleChanged = role !== undefined && role !== target.role;

  // Nobody may demote, suspend or otherwise change their own account through
  // this endpoint (profile edits go through /users/me/profile).
  if (String(target._id) === String(req.user?._id)) {
    throw ApiError.badRequest(
      "You cannot change your own account here — use your profile settings",
    );
  }

  // Privilege-escalation guard: only an Owner may assign or remove the Owner role.
  if (role !== undefined && role !== target.role) {
    await assertRoleExists(role);
    if ((role === "Owner" || target.role === "Owner") && req.user?.role !== "Owner") {
      throw ApiError.forbidden("Only the Owner can assign or change the Owner role");
    }
  }

  const updatePayload = {};
  if (name !== undefined) updatePayload.name = name;
  if (role !== undefined) updatePayload.role = role;
  if (roleChanged) {
    updatePayload.roleId = (await resolveRoleId(role)) ?? null;
    // When the role changes, reset per-user permission overrides to empty so
    // the new role's defaults take effect cleanly. Old overrides were built for
    // the previous role and would conflict with the new role's permission
    // matrix (e.g. a Cashier's explicit sales denials persisted after
    // reassignment to Pharmacist would incorrectly block sales actions that
    // Pharmacist is allowed to perform). The frontend simultaneously sends
    // updated accessIds which the accessIds whitelist in getEffectivePermissions
    // will enforce.
    updatePayload.permissions = {};
  }
  if (status !== undefined) {
    // `status` is the single source of truth; `active` is kept in sync so the
    // rest of the app (login guard, sidebars) reacts immediately.
    updatePayload.status = status;
    updatePayload.active = status === "active";
  } else if (active !== undefined) {
    updatePayload.active = active;
    if (active) updatePayload.status = "active";
    else if (target.status === "active") updatePayload.status = "inactive";
  }
  if (phone !== undefined) updatePayload.phone = phone;
  if (permissions !== undefined) {
    // Per-user permission overrides (deltas). Merged over the role defaults at
    // request time by the authorization middleware — this never rewrites the
    // role's own defaults.
    updatePayload.permissions = sanitizePermissionOverrides(permissions);
  }
  if (featureAccess !== undefined) {
    // Feature capabilities (e.g. staff administration toggles) stored verbatim,
    // mirroring how invitation-time feature access is persisted.
    updatePayload.featureAccess = featureAccess;
  }
  if (accessIds !== undefined) {
    // Explicit allowed-module whitelist from the Staff Access dialog. Persisted
    // verbatim (sanitized against the known module catalog) so granted modules
    // survive a refresh / re-login instead of reverting to role defaults.
    updatePayload.accessIds = sanitizeAccessModules(accessIds);
  }
  if (department !== undefined) updatePayload.department = department;
  if (designation !== undefined) updatePayload.designation = designation;
  // A role/access edit that arrives WITHOUT explicit permission deltas expresses
  // its complete intent through { role, accessIds, featureAccess }. Any per-user
  // override matrix stored earlier (e.g. deny-deltas precomputed against a
  // since-changed role configuration) would silently contradict the freshly
  // saved whitelist/capabilities, so it is dropped. Capability toggles are
  // enforced server-side by getEffectivePermissions from featureAccess.
  if (
    permissions === undefined &&
    updatePayload.permissions === undefined &&
    (roleChanged || accessIds !== undefined || featureAccess !== undefined)
  ) {
    updatePayload.permissions = {};
  }
  if (email !== undefined) {
    const normalized = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalized, _id: { $ne: target._id } }).collation({
      locale: "en",
      strength: 2,
    });
    if (existing) throw ApiError.conflict("A user with this email already exists");
    updatePayload.email = normalized;
  }

  const user = await User.findByIdAndUpdate(req.params.id, updatePayload, {
    new: true,
    runValidators: true,
  });

  // Change detection — an email is only sent when an actual relevant change
  // occurred. "Saved with no changes" must never fire a notification.
  const accessIdsChanged =
    accessIds !== undefined &&
    !sameStringArray(target.accessIds ?? [], updatePayload.accessIds ?? []);
  const permissionChanged =
    permissions !== undefined &&
    submittedDiffers(
      sanitizePermissionOverrides(permissions),
      normalizePermissions(target.permissions),
    );
  const featureChanged =
    featureAccess !== undefined && submittedDiffers(featureAccess, target.featureAccess ?? {});
  const departmentChanged =
    department !== undefined && (department ?? null) !== (target.department ?? null);
  const designationChanged =
    designation !== undefined && (designation ?? null) !== (target.designation ?? null);

  const auditDetails = {};
  if (roleChanged) auditDetails.role = { from: target.role, to: role };
  if (permissionChanged) auditDetails.permissions = sanitizePermissionOverrides(permissions);
  if (featureChanged) auditDetails.featureAccess = featureAccess;
  if (accessIdsChanged)
    auditDetails.accessIds = { from: target.accessIds ?? [], to: updatePayload.accessIds ?? [] };
  if (departmentChanged)
    auditDetails.department = {
      from: target.department ?? null,
      to: updatePayload.department ?? null,
    };
  if (designationChanged)
    auditDetails.designation = {
      from: target.designation ?? null,
      to: updatePayload.designation ?? null,
    };

  const accessChanged =
    accessIdsChanged ||
    permissionChanged ||
    featureChanged ||
    departmentChanged ||
    designationChanged;
  const shouldNotify = roleChanged || accessChanged;

  if (status !== undefined && status !== (target.status ?? "active")) {
    const action =
      status === "active"
        ? "User activated"
        : status === "suspended"
          ? "User suspended"
          : "User marked inactive";
    recordAudit({
      userId: req.user?._id,
      userName: req.user?.name,
      action,
      entityType: "user",
      entityId: user._id,
      details: { ...auditDetails, from: target.status ?? "active", to: status },
      ip: req.ip,
    });
  } else {
    recordAudit({
      userId: req.user?._id,
      userName: req.user?.name,
      action: "User updated",
      entityType: "user",
      entityId: user._id,
      details: auditDetails,
      ip: req.ip,
    });
  }

  // The affected user must be notified whenever their role or access actually
  // changed. The email is built from the real previous/new role (when changed),
  // the effective permission matrix after the change and the re-login
  // requirement. A delivery failure NEVER rolls back the change — it is logged
  // and surfaced via the audit trail instead. When role and access change in
  // the same save, exactly ONE consolidated email is sent.
// After sending email, capture result. emailSent is null when no notification
// was required (nothing relevant changed) so callers never misread "no email
// needed" as "email delivered".
let emailSent = null;
let emailError = null;
if (shouldNotify) {
  const kind = roleChanged && accessChanged ? "both" : roleChanged ? "role" : "access";
  const [effectivePermissions, previousPermissions] = await Promise.all([
    getEffectivePermissions(user.toObject()),
    getEffectivePermissions(target.toObject()),
  ]);
  const { subject, html, text } = buildRoleChangeEmail({
    name: user.name,
    orgName: user.orgName,
    ...(roleChanged ? { previousRole: target.role } : {}),
    newRole: user.role,
    permissions: effectivePermissions,
    previousPermissions,
    features: user.featureAccess,
    previousFeatures: target.featureAccess,
    changedBy: req.user?.name,
    link: `${env.frontendUrl}/login`,
  });
  try {
    logger.info(`[MAIL DEBUG] flow=ACCESS_UPDATE recipient=${user.email} mailServiceCalled=true`);
    const sendResult = await sendEmail({ to: user.email, subject, html, text });
    logger.info(
      `[MAIL DEBUG] flow=ACCESS_UPDATE sendResult=${sendResult?.skipped ? "skipped" : "success"} recipient=${user.email} kind=${kind}`,
    );
    logger.info(
      `[users.update] role/access-change email — recipient=${user.email} skipped=${Boolean(sendResult?.skipped)} kind=${kind}`,
    );
    recordAudit({
      userId: req.user?._id,
      userName: req.user?.name,
      action: sendResult?.skipped
        ? "Role change email skipped (SMTP not configured)"
        : "Role change email sent",
      entityType: "user",
      entityId: user._id,
      details: { kind, subject },
      ip: req.ip,
    });
    emailSent = !sendResult?.skipped;
  } catch (err) {
    logger.error(
      `[users.update] role-change email failed for ${user.email} — role change kept`,
      err,
    );
    recordAudit({
      userId: req.user?._id,
      userName: req.user?.name,
      action: "Role change email failed",
      entityType: "user",
      entityId: user._id,
      details: { kind, subject },
      ip: req.ip,
    });
    emailSent = false;
    emailError = err.message || "Email send failed";
  }
}
// Return response with email status
return ok(
  res,
  {
    user: toPublicUser(user.toObject()),
    emailSent,
    ...(emailError && { emailError }),
  },
  "User updated",
);
});

// Notify the removed staff member AFTER the removal has succeeded. A delivery
// failure NEVER rolls back the removal — it is logged and surfaced via the
// audit trail instead. Returns { emailSent, emailSkipped, emailError } so the
// caller can include email status in the API response.
async function notifyStaffRemoval({ to, name, orgName, entityType, entityId, actor, ip }) {
  const removalEmailSubject = "You are no longer a member of PharmaHub";
  try {
    const { subject, html, text } = buildStaffRemovalEmail({ name, orgName });
    logger.info(`[MAIL DEBUG] flow=REMOVAL recipient=${to} mailServiceCalled=true`);
    const sendResult = await sendEmail({ to, subject, html, text });
    logger.info(
      `[MAIL DEBUG] flow=REMOVAL sendResult=${sendResult?.skipped ? "skipped" : "success"} recipient=${to}`,
    );
    logger.info(
      `[users.remove] staff-removal email — to=${to} skipped=${Boolean(sendResult?.skipped)}`,
    );
    recordAudit({
      userId: actor?._id,
      userName: actor?.name,
      action: sendResult?.skipped
        ? "Staff removal email skipped (SMTP not configured)"
        : "Staff removal email sent",
      entityType,
      entityId: String(entityId),
      details: { subject },
      ip,
    });
    return { emailSent: !sendResult?.skipped, emailSkipped: Boolean(sendResult?.skipped) };
  } catch (err) {
    logger.error(`[users.remove] staff-removal email failed for ${to} — removal kept`, err);
    recordAudit({
      userId: actor?._id,
      userName: actor?.name,
      action: "Staff removal email failed",
      entityType,
      entityId: String(entityId),
      details: { subject: removalEmailSubject },
      ip,
    });
    return { emailSent: false, emailSkipped: false, emailError: err.message || "Email send failed" };
  }
}

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  // A pending invitee has no user row yet — the removal is targeted by the
  // invitation id. The invitation is revoked so its link can never be used,
  // and the invitee is notified like any removed staff member.
  if (!user) {
    const invitation = await Invitation.findById(req.params.id);
    if (!invitation) throw ApiError.notFound("Staff member not found.");
    if (invitation.status !== "pending") {
      throw ApiError.badRequest("Pending invitation not found.");
    }
    assertSameOrganization(invitation, req.user);
    invitation.status = "revoked";
    invitation.cancelledAt = new Date();
    invitation.cancelledBy = req.user._id;
    await invitation.save();
    recordAudit({
      userId: req.user?._id,
      userName: req.user?.name,
      action: "Staff removed (pending invitation)",
      entityType: "invitation",
      entityId: invitation._id,
      ip: req.ip,
    });
    const removalEmail = await notifyStaffRemoval({
      to: invitation.email,
      name: invitation.name ?? invitation.email,
      orgName: invitation.orgName,
      entityType: "invitation",
      entityId: invitation._id,
      actor: req.user,
      ip: req.ip,
    });
    return ok(
      res,
      { ...removalEmail },
      removalEmail.emailSkipped
        ? "Staff removed. Email notification skipped — SMTP is not configured."
        : removalEmail.emailSent
          ? "Staff removed and notification email sent."
          : "Staff removed. Email notification could not be sent.",
    );
  }

  if (String(user._id) === String(req.user?._id)) {
    throw ApiError.badRequest("You cannot remove your own account");
  }
  // The organization Owner is protected from the normal staff-removal flow —
  // removing the Owner requires a different (explicit) process.
  if (user.role === "Owner") {
    throw ApiError.forbidden("Organization owner cannot be removed.");
  }
  assertSameOrgOrAllow(user, req.user);
  if (user.status === "removed") {
    throw ApiError.badRequest("This user has already been removed");
  }

  // Soft delete: the account can never sign in again, but the row (and its
  // audit trail) is preserved so historical records stay intact.
  user.status = "removed";
  user.active = false;
  user.removedAt = new Date();
  user.removedBy = req.user._id;
  await user.save();

  // Any invitations for this email are now obsolete — they are revoked
  // (distinct from time-based expiry) so a stale invite link can never
  // resurrect a removed account. This includes already-accepted invitations:
  // they are lifecycle records of the removed user, and leaving them
  // "accepted" would let the invitations list re-add the user as active
  // staff. Accepting an invitation is guarded against revoked status.
  await Invitation.updateMany(
    { email: user.email, status: { $nin: ["revoked"] } },
    { status: "revoked", cancelledAt: new Date(), cancelledBy: req.user._id },
  );

  recordAudit({
    userId: req.user?._id,
    userName: req.user?.name,
    action: "User removed",
    entityType: "user",
    entityId: user._id,
    ip: req.ip,
  });

  const removalEmail = await notifyStaffRemoval({
    to: user.email,
    name: user.name,
    orgName: user.orgName,
    entityType: "user",
    entityId: user._id,
    actor: req.user,
    ip: req.ip,
  });

  return ok(
    res,
    { user: toPublicUser(user.toObject()), ...removalEmail },
    removalEmail.emailSkipped
      ? "User removed. Email notification skipped — SMTP is not configured."
      : removalEmail.emailSent
        ? "User removed and notification email sent."
        : "User removed. Email notification could not be sent.",
  );
});

export const inviteUser = asyncHandler(async (req, res) => {
  const { name, email, role, message, phone, department, permissions, featureAccess, accessIds } = req.body;
  logger.info(
    `[users.invite] POST /users/invite — by=${req.user.email} org=${req.user.orgName ?? "(none)"} target=${email ?? "(missing)"} role=${role ?? "(missing)"}`,
  );
  if (!email || !role) throw ApiError.badRequest("Email and role are required");
  await assertRoleExists(role);
  logger.info(`[users.invite] role "${role}" verified`);

  const normalizedEmail = email.toLowerCase().trim();

  // Check if a live user already exists (case-insensitive, consistent with
  // registerUser/loginUser so Moki@Gmail.com and moki@gmail.com are the same).
  // A removed (soft-deleted) user is re-invitable: accepting a new invitation
  // re-activates their existing account instead of creating a duplicate.
  const existingUser = await User.findOne({ email: normalizedEmail }).collation({
    locale: "en",
    strength: 2,
  });
  if (existingUser && existingUser.status !== "removed") {
    throw ApiError.conflict("A user with this email already exists");
  }

  // Invalidate any prior pending invitations for this email
  await Invitation.updateMany({ email: normalizedEmail, status: "pending" }, { status: "expired" });

  // Generate a cryptographically secure token — only its hash is stored.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + constants.security.invitationTtlMs);

  const invitation = await Invitation.create({
    email: normalizedEmail,
    role,
    roleId: (await resolveRoleId(role)) ?? null,
    name,
    message,
    phone,
    department: department?.trim() || null,
    invitedBy: req.user._id,
    orgName: req.user.orgName ?? "",
    tokenHash,
    expiresAt,
    status: "pending",
    // Owner-configured per-user overrides + feature access are persisted with
    // the invitation and transferred verbatim to the user on acceptance.
    permissions: sanitizePermissionOverrides(permissions),
    featureAccess: featureAccess ?? {},
    accessIds: sanitizeAccessModules(accessIds),
  });
  logger.info(`[users.invite] invitation created id=${String(invitation._id)} status=pending`);

  const link = `${env.frontendUrl}/accept-invitation?token=${rawToken}`;
  const { subject, html, text } = buildInvitationEmail({
    name: name?.trim(),
    orgName: req.user.orgName,
    role,
    link,
    expiresInHours: constants.security.invitationTtlHours,
    message,
    email: normalizedEmail,
  });

  let sendResult;
  logger.info(`[MAIL DEBUG] flow=INVITATION recipient=${normalizedEmail} mailServiceCalled=true`);
  try {
    sendResult = await sendEmail({ to: normalizedEmail, subject, html, text });
    logger.info(
      `[MAIL DEBUG] flow=INVITATION sendResult=${sendResult?.skipped ? "skipped" : "success"} recipient=${normalizedEmail}`,
    );
    logger.info(
      `[users.invite] Invitation email — recipient=${normalizedEmail} skipped=${Boolean(sendResult?.skipped)}`,
    );
  } catch (err) {
    logger.info(`[MAIL DEBUG] flow=INVITATION sendResult=failure recipient=${normalizedEmail}`);
    logger.error("[users.invite] email send failed — rolling back invitation", err);
    // Email delivery failed → rollback the invitation so we never leave a
    // dangling token behind with no way for the invitee to use it.
    await Invitation.deleteOne({ _id: invitation._id });
    recordAudit({
      userId: req.user._id,
      userName: req.user.name,
      action: "Invitation rolled back (email send failed)",
      entityType: "invitation",
      entityId: String(invitation._id),
      ip: req.ip,
    });
    throw ApiError.badRequest(
      "Invitation could not be emailed. Please check the email address and try again.",
    );
  }

  if (sendResult.skipped) {
    // SMTP is not configured — the invitation is kept (dev/demo flow) but we
    // are explicit that no email was delivered instead of pretending it was.
    recordAudit({
      userId: req.user._id,
      userName: req.user.name,
      action: "User invited (email skipped — SMTP not configured)",
      entityType: "invitation",
      entityId: String(invitation._id),
      ip: req.ip,
    });
    return created(
      res,
      {
        id: String(invitation._id),
        email: normalizedEmail,
        role,
        name,
        phone,
        expiresAt,
        status: "pending",
        link,
        emailSkipped: true,
      },
      "Invitation created. Email delivery skipped — SMTP is not configured.",
    );
  }

  recordAudit({
    userId: req.user._id,
    userName: req.user.name,
    action: "User invited",
    entityType: "invitation",
    entityId: String(invitation._id),
    ip: req.ip,
  });

  // Return success without exposing the raw token
  return created(
    res,
    {
      id: String(invitation._id),
      email: normalizedEmail,
      role,
      name,
      phone,
      expiresAt,
      status: "pending",
      link,
      emailSent: true,
    },
    "Invitation sent",
  );
});

// GET /users/invite/:token — public, pre-auth validation for the accept page.
// Only reveals non-secret invitation info; the raw token is never returned.
export const getInvitation = asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token) throw ApiError.badRequest("Invitation token is required");

  const tokenHash = hashToken(token);
  const invitation = await Invitation.findOne({ tokenHash }).lean();
  if (!invitation) throw ApiError.notFound("Invitation not found or no longer valid");

  let status = invitation.status;
  if (status === "pending" && invitation.expiresAt < new Date()) {
    status = "expired";
    await Invitation.updateOne({ _id: invitation._id }, { status: "expired" });
  }

  return ok(res, {
    valid: status === "pending",
    status,
    email: invitation.email,
    name: invitation.name ?? "",
    role: invitation.role,
    orgName: invitation.orgName ?? "",
    expiresAt: invitation.expiresAt,
    permissions: normalizePermissions(invitation.permissions),
    featureAccess: invitation.featureAccess ?? {},
  });
});

export const acceptInvitation = asyncHandler(async (req, res) => {
  const { token, name, password, phone } = req.body;
  if (!token) throw ApiError.badRequest("Invitation token is required");
  if (!password) throw ApiError.badRequest("Password is required");

  const tokenHash = hashToken(token);
  const invitation = await Invitation.findOne({ tokenHash }).select("+tokenHash");
  if (!invitation) throw ApiError.notFound("Invitation not found or no longer valid");

  if (invitation.status === "accepted" || invitation.status === "used") {
    throw ApiError.badRequest("This invitation has already been accepted");
  }
  if (invitation.status === "cancelled")
    throw ApiError.badRequest("This invitation has been cancelled");
  if (invitation.status === "revoked")
    throw ApiError.badRequest("This invitation has been revoked");
  if (invitation.status === "expired") throw ApiError.badRequest("This invitation has expired");
  if (invitation.expiresAt < new Date()) {
    await Invitation.updateOne({ _id: invitation._id }, { status: "expired" });
    throw ApiError.badRequest("This invitation has expired");
  }

  await assertRoleExists(invitation.role);

  const passwordHash = await bcrypt.hash(password, 10);

  // The Owner's invitation-time permission overrides + feature access transfer
  // verbatim to the user document — custom restrictions are never replaced by
  // the role defaults.
  const permissionOverrides = sanitizePermissionOverrides(invitation.permissions);
  const featureAccess = invitation.featureAccess ?? {};

  // Never create a duplicate account: if a user already exists for this email
  // (matched case-insensitively, consistent with registerUser/loginUser), link
  // the invitation to that account instead — assigning the invited role, the
  // inviter's organization, the active status and the new password hash.
  const existing = await User.findOne({ email: invitation.email }).collation({
    locale: "en",
    strength: 2,
  });

  let user;
  if (existing) {
    existing.name = name?.trim() || invitation.name || existing.name;
    existing.passwordHash = passwordHash;
    existing.role = invitation.role;
    existing.roleId = invitation.roleId ?? null;
    existing.accessIds = invitation.accessIds ?? [];
    existing.orgName = invitation.orgName ?? existing.orgName ?? "";
    if (phone?.trim()) existing.phone = phone.trim();
    // Department captured on the New Staff form travels with the invitation.
    if (invitation.department) existing.department = invitation.department;
    existing.permissions = permissionOverrides;
    existing.featureAccess = featureAccess;
    existing.status = "active";
    existing.active = true;
    await existing.save();
    user = existing;
  } else {
    user = await User.create({
      name: name?.trim() || invitation.name || "User",
      email: invitation.email,
      passwordHash,
      role: invitation.role,
      roleId: invitation.roleId ?? null,
      accessIds: invitation.accessIds ?? [],
      orgName: invitation.orgName ?? "",
      phone: phone?.trim() || invitation.phone || undefined,
      department: invitation.department ?? null,
      permissions: permissionOverrides,
      featureAccess,
      status: "active",
      active: true,
    });
  }

  await Invitation.updateOne(
    { _id: invitation._id },
    {
      status: "accepted",
      acceptedAt: new Date(),
      acceptedBy: user._id,
    },
  );

  recordAudit({
    userId: user._id,
    userName: user.name,
    action: "Invitation accepted",
    entityType: "invitation",
    entityId: String(invitation._id),
    ip: req.ip,
  });

  const authToken = issueToken(user._id);
  const publicUser = await toAuthUser(user.toObject());
  publicUser.profileCompletion = await saveProfileCompletion(user);
  return created(res, { token: authToken, user: publicUser }, "Invitation accepted");
});

// POST /users/invite/:id/resend — issues a fresh one-time token, replaces the
// stored hash and expires the previous link (which can no longer be used).
export const resendInvitation = asyncHandler(async (req, res) => {
  logger.info(
    `[users.resend] POST /users/invite/${req.params.id}/resend — by=${req.user.email} org=${req.user.orgName ?? "(none)"}`,
  );
  const invitation = await Invitation.findById(req.params.id).select("+tokenHash");
  if (!invitation) throw ApiError.notFound("Invitation not found");
  if (invitation.status !== "pending") {
    throw ApiError.badRequest("Only pending invitations can be resent");
  }
  assertSameOrganization(invitation, req.user);

  const existingUser = await User.findOne({ email: invitation.email }).collation({
    locale: "en",
    strength: 2,
  });
  if (existingUser && existingUser.status !== "removed") {
    throw ApiError.conflict("A user with this email already exists");
  }

  const previous = {
    tokenHash: invitation.tokenHash,
    expiresAt: invitation.expiresAt,
    status: invitation.status,
  };

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + constants.security.invitationTtlMs);

  invitation.tokenHash = tokenHash;
  invitation.expiresAt = expiresAt;
  invitation.status = "pending";
  await invitation.save();

  const link = `${env.frontendUrl}/accept-invitation?token=${rawToken}`;
  const { subject, html, text } = buildInvitationEmail({
    name: invitation.name,
    orgName: invitation.orgName,
    role: invitation.role,
    link,
    expiresInHours: constants.security.invitationTtlHours,
    message: invitation.message,
    email: invitation.email,
  });

  let sendResult;
  try {
    sendResult = await sendEmail({ to: invitation.email, subject, html, text });
    logger.info(
      `[users.resend] Invitation email — recipient=${invitation.email} skipped=${Boolean(sendResult?.skipped)}`,
    );
  } catch (err) {
    logger.error("[users.resend] email send failed — restoring previous token", err);
    // Restore the previous token so the old link still works if resend failed.
    await Invitation.updateOne({ _id: invitation._id }, previous);
    throw ApiError.badRequest("Invitation could not be emailed. Please try again.");
  }

  if (sendResult.skipped) {
    recordAudit({
      userId: req.user._id,
      userName: req.user.name,
      action: "Invitation resent (email skipped — SMTP not configured)",
      entityType: "invitation",
      entityId: String(invitation._id),
      ip: req.ip,
    });
    return ok(
      res,
      {
        id: String(invitation._id),
        email: invitation.email,
        role: invitation.role,
        expiresAt,
        status: "pending",
        link,
        emailSkipped: true,
      },
      "Invitation resent. Email delivery skipped — SMTP is not configured.",
    );
  }

  recordAudit({
    userId: req.user._id,
    userName: req.user.name,
    action: "Invitation resent",
    entityType: "invitation",
    entityId: String(invitation._id),
    ip: req.ip,
  });

  return ok(
    res,
    {
      id: String(invitation._id),
      email: invitation.email,
      role: invitation.role,
      expiresAt,
      status: "pending",
      link,
      emailSent: true,
    },
    "Invitation resent",
  );
});

// DELETE /users/invite/:id — cancels a pending invitation; its token stops working.
export const cancelInvitation = asyncHandler(async (req, res) => {
  logger.info(
    `[users.cancel] DELETE /users/invite/${req.params.id} — by=${req.user.email} org=${req.user.orgName ?? "(none)"}`,
  );
  const invitation = await Invitation.findById(req.params.id);
  if (!invitation) throw ApiError.notFound("Invitation not found");
  if (invitation.status !== "pending") {
    throw ApiError.badRequest("Only pending invitations can be cancelled");
  }
  assertSameOrganization(invitation, req.user);

  invitation.status = "cancelled";
  invitation.cancelledAt = new Date();
  invitation.cancelledBy = req.user._id;
  await invitation.save();
  logger.info(`[users.cancel] invitation id=${String(invitation._id)} status=cancelled`);

  recordAudit({
    userId: req.user._id,
    userName: req.user.name,
    action: "Invitation cancelled",
    entityType: "invitation",
    entityId: String(invitation._id),
    ip: req.ip,
  });

  return ok(res, null, "Invitation cancelled");
});

// GET /users/invite/:id/link — returns a fresh shareable invitation link for a
// pending invitation. Generates a new token (replacing the old one) so the link
// can be shared manually when email delivery fails or is skipped.
export const getInvitationLink = asyncHandler(async (req, res) => {
  logger.info(
    `[users.link] GET /users/invite/${req.params.id}/link — by=${req.user.email} org=${req.user.orgName ?? "(none)"}`,
  );
  const invitation = await Invitation.findById(req.params.id).select("+tokenHash");
  if (!invitation) throw ApiError.notFound("Invitation not found");
  if (invitation.status !== "pending") {
    throw ApiError.badRequest("Only pending invitations have a shareable link");
  }
  assertSameOrganization(invitation, req.user);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  invitation.tokenHash = tokenHash;
  await invitation.save();

  const link = `${env.frontendUrl}/accept-invitation?token=${rawToken}`;
  return ok(res, { link }, "Invitation link retrieved");
});

// GET /users/invitations — invitation history scoped to the caller's organization,
// used by the Users & Roles screen to surface Pending/Accepted/Expired/Cancelled.
export const listInvitations = asyncHandler(async (req, res) => {
  const orgNameRegex = req.user.orgName
    ? new RegExp(`^${req.user.orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
    : null;

  const filter = {
    status: { $nin: ["accepted", "used"] },
    ...(req.user.role === "Owner"
      ? orgNameRegex
        ? {
            $or: [
              { orgName: orgNameRegex },
              { orgName: { $in: ["", null] } },
              { orgName: { $exists: false } },
              { invitedBy: req.user._id },
            ],
          }
        : {}
      : orgNameRegex
        ? { $or: [{ orgName: orgNameRegex }, { invitedBy: req.user._id }] }
        : { invitedBy: req.user._id }),
  };

  const invitations = await Invitation.find(filter).sort({ createdAt: -1 }).lean();

  // Treat lapsed pending invitations as expired server-side so the UI never
  // has to guess at expiration.
  const now = new Date();
  const lapsed = invitations
    .filter((inv) => inv.status === "pending" && inv.expiresAt < now)
    .map((inv) => inv._id);
  if (lapsed.length > 0) {
    await Invitation.updateMany({ _id: { $in: lapsed }, status: "pending" }, { status: "expired" });
  }

  return ok(
    res,
    invitations.map((inv) => {
      const status = inv.status === "pending" && inv.expiresAt < now ? "expired" : inv.status;
      return {
        id: String(inv._id),
        email: inv.email,
        name: inv.name ?? "",
        role: inv.role,
        orgName: inv.orgName ?? "",
        phone: inv.phone ?? null,
        department: inv.department ?? null,
        accessIds: inv.accessIds ?? [],
        status,
        expiresAt: inv.expiresAt,
        acceptedAt: inv.acceptedAt ?? null,
        acceptedBy: inv.acceptedBy ? String(inv.acceptedBy) : null,
        cancelledAt: inv.cancelledAt ?? null,
        createdAt: inv.createdAt,
        resendable: status === "pending",
        cancelable: status === "pending",
        permissions: normalizePermissions(inv.permissions),
        featureAccess: inv.featureAccess ?? {},
      };
    }),
  );
});
