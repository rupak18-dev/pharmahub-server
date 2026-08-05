export function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

export function daysUntil(date) {
  const ms = new Date(date).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export function classifyBatchStatus(expiryDate, nearExpiryDays) {
  const days = daysUntil(expiryDate);
  if (days < 0) return "expired";
  if (days <= nearExpiryDays) return "near_expiry";
  return "active";
}

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
