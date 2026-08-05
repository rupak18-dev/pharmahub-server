import { constants } from "../config/constants.js";

export function buildPagination(query = {}) {
  const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
  const sizeRaw = parseInt(query.limit ?? String(constants.limits.defaultPageSize), 10) || 1;
  const limit = Math.min(sizeRaw, constants.limits.maxPageSize);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function paginationMeta(total, { page, limit }) {
  return {
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 0,
    hasMore: page * limit < total,
  };
}

export function cleanQuery(query = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "page" || key === "limit" || key === "sort") continue;
    clean[key] = value;
  }
  return clean;
}
