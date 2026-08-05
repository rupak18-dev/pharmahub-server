import { asyncHandler } from "../core/asyncHandler.js";
import { ApiError } from "../core/ApiError.js";
import { ok, created, noContent } from "../core/responses.js";
import { buildPagination, paginationMeta, cleanQuery } from "../utils/pagination.js";
import { Manufacturer } from "../models/Manufacturer.js";
import { recordAudit } from "../services/audit.service.js";

export const listManufacturers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const filter = cleanQuery(req.query);
  if (req.query.q) filter.name = { $regex: req.query.q, $options: "i" };
  delete filter.q;
  const [items, total] = await Promise.all([
    Manufacturer.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
    Manufacturer.countDocuments(filter),
  ]);
  return ok(res, items, "Manufacturers", paginationMeta(total, { page, limit }));
});

export const getManufacturer = asyncHandler(async (req, res) => {
  const item = await Manufacturer.findById(req.params.id).lean();
  if (!item) throw ApiError.notFound("Manufacturer not found");
  return ok(res, item);
});

export const createManufacturer = asyncHandler(async (req, res) => {
  const item = await Manufacturer.create(req.body);
  recordAudit({ userId: req.user?._id, userName: req.user?.name, action: "Manufacturer created", entityType: "manufacturer", entityId: item._id, ip: req.ip });
  return created(res, item, "Manufacturer created");
});

export const updateManufacturer = asyncHandler(async (req, res) => {
  const item = await Manufacturer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) throw ApiError.notFound("Manufacturer not found");
  return ok(res, item, "Manufacturer updated");
});

export const deleteManufacturer = asyncHandler(async (req, res) => {
  const item = await Manufacturer.findById(req.params.id);
  if (!item) throw ApiError.notFound("Manufacturer not found");
  await item.deleteOne();
  return noContent(res);
});
