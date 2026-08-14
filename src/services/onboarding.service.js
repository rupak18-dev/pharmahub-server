import { Onboarding } from "../models/Onboarding.js";

export async function getOnboarding(userId) {
  return Onboarding.findOne({ userId }).lean();
}

export async function upsertOnboarding(userId, data) {
  const existing = await Onboarding.findOne({ userId });

  if (!existing) {
    return Onboarding.create({ userId, ...data });
  }

  if (data.businessType !== undefined) existing.businessType = data.businessType;
  if (data.personal !== undefined) {
    existing.personal = {
      ...(existing.personal?.toObject?.() ?? existing.personal),
      ...data.personal,
    };
  }
  if (data.workspace !== undefined) {
    existing.workspace = {
      ...(existing.workspace?.toObject?.() ?? existing.workspace),
      ...data.workspace,
    };
  }
  if (data.quickStart !== undefined) existing.quickStart = data.quickStart;
  if (data.currentStep !== undefined) existing.currentStep = data.currentStep;
  if (data.completedAt !== undefined) existing.completedAt = data.completedAt;

  await existing.save();
  return existing;
}
