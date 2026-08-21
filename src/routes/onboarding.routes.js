import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { asyncHandler } from "../core/asyncHandler.js";
import { ok } from "../core/responses.js";
import { Onboarding } from "../models/Onboarding.js";
import { User } from "../models/User.js";

const router = Router();

router.get(
  "/",
  auth,
  asyncHandler(async (req, res) => {
    const record = await Onboarding.findOne({ userId: req.user._id }).lean();
    return ok(res, record || {}, "Onboarding data");
  }),
);

router.put(
  "/",
  auth,
  asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const updated = await Onboarding.findOneAndUpdate(
      { userId: req.user._id },
      { $set: { ...payload, userId: req.user._id } },
      { new: true, upsert: true },
    );
    if (payload.onboarded) {
      await User.findByIdAndUpdate(req.user._id, { onboarded: true });
    }
    return ok(res, updated, "Onboarding updated");
  }),
);

export default router;
