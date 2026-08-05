import { ApiError } from "../core/ApiError.js";
import { Role } from "../models/Role.js";

async function getPermissions(roleName) {
  const role = await Role.findOne({ name: roleName }).lean();
  return role?.permissions ?? null;
}

export function authorize(module, action = "view") {
  return async (req, _res, next) => {
    try {
      const roleName = req.user?.role;
      if (!roleName) throw ApiError.forbidden("Missing role");

      const permissions = await getPermissions(roleName);
      if (!permissions) throw ApiError.forbidden(`Role "${roleName}" not configured`);

      const allowed = permissions[module]?.[action];
      if (!allowed) {
        throw ApiError.forbidden(
          `Role "${roleName}" is not allowed to ${action} ${module}`,
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
