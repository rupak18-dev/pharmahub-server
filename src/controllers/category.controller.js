import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { Category } from "../models/Category.js";
import { recordAudit } from "../services/audit.service.js";

export const listCategories = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (req.query.q) filter.name = { $regex: req.query.q, $options: "i" };
  delete filter.q;
  const [items, total] = await Promise.all([
    Category.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Category.countDocuments(filter),
  ]);
  return ok(res, items, "Categories", paginationMeta(total, { page, limit }));
});

export const getCategory = asyncHandler(async (req, res) => {
  const item = await Category.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Category not found");
  return ok(res, item);
});

export const createCategory = asyncHandler(async (req, res) => {
  const item = await Category.create(req.body);
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "Category created", entityType: "category", entityId: item._id, ip: req.ip });
  return created(res, item, "Category created");
});

export const updateCategory = asyncHandler(async (req, res) => {
  const item = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw ApiError.notFound("Category not found");
  return ok(res, item, "Category updated");
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const item = await Category.findById(req.params.id);
  if (!item) throw ApiError.notFound("Category not found");
  await item.deleteOne();
  return noContent(res);
});
