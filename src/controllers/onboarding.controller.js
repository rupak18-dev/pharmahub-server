import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import { getOnboarding, upsertOnboarding } from "../services/onboarding.service.js";

export const get = asyncHandler(async (req, res) => {
  const data = await getOnboarding(req.user._id);
  return ok(res, data, "Onboarding data");
});

export const save = asyncHandler(async (req, res) => {
  const data = await upsertOnboarding(req.user._id, req.body);
  return ok(res, data, "Onboarding data saved");
});
