import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "../core/ApiError.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Runtime storage root for uploaded files. Kept inside the server package so
// deployments with a writable working directory work out of the box; the
// directory can be relocated via UPLOAD_DIR.
export const uploadsDir = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads"),
);
export const profileUploadDir = path.join(uploadsDir, "profile");
export const billUploadDir = path.join(uploadsDir, "bills");

// Only these image types are accepted for profile avatars.
const ALLOWED_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — must match the UI

// Max size for uploaded bill images (MB, env-configurable). Must match the UI.
export const BILL_MAX_BYTES = (parseFloat(process.env.BILL_UPLOAD_MAX_MB) || 10) * 1024 * 1024;

function ensureUploadDirs() {
  fs.mkdirSync(profileUploadDir, { recursive: true });
  fs.mkdirSync(billUploadDir, { recursive: true });
}
ensureUploadDirs();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDirs();
    cb(null, profileUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype];
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) return cb(null, true);
    return cb(ApiError.badRequest("Only JPEG, PNG and WEBP images are allowed"));
  },
}).single("file");
uploadAvatar.maxBytes = AVATAR_MAX_BYTES;

// Bill image uploads. Same image whitelist as avatars, larger size limit,
// stored under /uploads/bills with a random safe filename. The original
// extension is derived from the validated MIME type, never the client name.
const billStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDirs();
    cb(null, billUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype] || ".jpg";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

export const uploadBillImage = multer({
  storage: billStorage,
  limits: { fileSize: BILL_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) return cb(null, true);
    return cb(ApiError.badRequest("Only JPEG, PNG and WEBP images are allowed"));
  },
}).single("file");
uploadBillImage.maxBytes = BILL_MAX_BYTES;

// Wraps the multer middleware so its errors surface as clean API errors
// instead of the raw MulterError the Express error handler would 500 on.
export function runUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          const mb = Math.round((uploadMiddleware.maxBytes || AVATAR_MAX_BYTES) / (1024 * 1024));
          return next(ApiError.badRequest(`Image is too large — maximum size is ${mb} MB`));
        }
        return next(ApiError.badRequest(`Upload failed: ${err.message}`));
      }
      return next(err);
    });
  };
}

// Resolves a stored relative path like "/uploads/profile/x.jpg" to an
// absolute path on disk, and only ever for files inside the uploads root.
export function storedFilePath(avatarUrl) {
  if (!avatarUrl || !avatarUrl.startsWith("/uploads/")) return null;
  const relative = avatarUrl.replace(/^\/uploads\//, "");
  const abs = path.join(uploadsDir, relative);
  const root = `${path.resolve(uploadsDir)}${path.sep}`;
  if (!abs.startsWith(root)) return null;
  return abs;
}

export function deleteStoredFile(avatarUrl) {
  const abs = storedFilePath(avatarUrl);
  if (!abs) return;
  fs.promises.unlink(abs).catch(() => {
    // File already gone — nothing to clean up.
  });
}
