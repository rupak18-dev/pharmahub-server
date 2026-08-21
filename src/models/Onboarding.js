import { Schema, model } from "mongoose";

const onboardingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    businessType: { type: String, default: null },
    personal: { type: Object, default: {} },
    workspace: { type: Object, default: {} },
    branding: { type: Object, default: {} },
    quickStart: { type: Array, default: [] },
    currentStep: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Onboarding = model("Onboarding", onboardingSchema);
