import { Schema, model } from "mongoose";

const onboardingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    businessType: {
      type: String,
      enum: ["retail", "dealer", "enterprise", "hospital", "other"],
      trim: true,
    },
    personal: {
      firstName: { type: String, trim: true, maxlength: 80 },
      lastName: { type: String, trim: true, maxlength: 80 },
      phone: { type: String, trim: true, maxlength: 20 },
      jobTitle: { type: String, trim: true, maxlength: 120 },
    },
    workspace: {
      organizationName: { type: String, trim: true, maxlength: 120 },
      branchName: { type: String, trim: true, maxlength: 120 },
      drugLicenseNumber: { type: String, trim: true, maxlength: 80 },
      gstNumber: { type: String, trim: true, maxlength: 80 },
    },
    quickStart: { type: [String], default: [] },
    currentStep: { type: Number, default: 0, min: 0 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Onboarding = model("Onboarding", onboardingSchema);
