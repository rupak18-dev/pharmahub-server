// Backend mirror of the profile fields the product tracks for completion.
// The frontend already had a local copy (src/lib/profileCompletion.js); the
// backend is now the source of truth and persists the result on the User so
// it survives reloads and matches across the API and the UI.
export const PROFILE_FIELDS = [
  "name",
  "email",
  "phone",
  "avatarUrl",
  "orgName",
  "tagline",
  "description",
  "businessEmail",
  "website",
  "address",
  "gstin",
  "licenseNo",
  "businessType",
];

function hasValue(value) {
  return Boolean(value && String(value).trim().length > 0);
}

export function computeProfileCompletion(user) {
  const completedFields = [];
  const missingFields = [];

  for (const field of PROFILE_FIELDS) {
    if (hasValue(user?.[field])) {
      completedFields.push(field);
    } else {
      missingFields.push(field);
    }
  }

  const totalCount = PROFILE_FIELDS.length;
  const completedCount = completedFields.length;

  return {
    percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
    completedCount,
    totalCount,
    completedFields,
    missingFields,
    updatedAt: new Date(),
  };
}

// Persists the freshly-computed completion on a hydrated User document.
export async function saveProfileCompletion(userDoc) {
  const completion = computeProfileCompletion(userDoc);
  userDoc.profileCompletion = completion;
  await userDoc.save();
  return completion;
}
