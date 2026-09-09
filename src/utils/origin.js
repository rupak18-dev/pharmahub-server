export function normalizeOrigins(raw) {
  if (!raw || raw === "*") return [];
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function isOriginAllowed(raw, origin) {
  if (!origin) return false;
  if (!raw || raw === "*") return true;
  return normalizeOrigins(raw).includes(origin);
}
