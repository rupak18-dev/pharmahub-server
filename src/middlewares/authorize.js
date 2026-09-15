import { ApiError } from "../core/ApiError.js";
import { getEffectivePermissions } from "../services/permissions.service.js";

export function authorize(module, action = "view") {
  return async (req, _res, next) => {
    try {
      if (!req.user) throw ApiError.unauthorized("Authentication required");
      if (!req.user.active || req.user.status === "removed") {
        throw ApiError.unauthorized("User account is inactive or removed");
      }

      const roleName = req.user.role;

      // Owner has full access across the system
      if (roleName === "Owner") {
        return next();
      }

      // Role-less / unassigned-role accounts are covered by the minimal
      // read-only baseline from getEffectivePermissions — a missing role on
      // its own is not reason to hard-deny every module.
      const permissions = await getEffectivePermissions(req.user);
      if (!permissions) throw ApiError.forbidden(`Permissions not configured`);

      const allowed = permissions[module]?.[action];
      if (!allowed) {
        throw ApiError.forbidden(`You are not authorized to ${action} ${module}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
