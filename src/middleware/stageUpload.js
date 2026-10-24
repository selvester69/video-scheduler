/**
 * Multer storage for staging uploaded video files to disk before they are
 * handed to the scheduler worker. Files live in STORAGE_ROOT until upload to
 * YouTube completes (then they may be pruned separately).
 */
import multer from "multer";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config.js";

const dir = config.storageRoot;
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const stageUpload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${extname(file.originalname)}`),
  }),
  limits: {
    fileSize: config.upload.maxFileSize,   // per-file cap (default 5 GB)
    files: config.upload.maxFiles,         // per-request file cap
  },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("video/") ||
      file.mimetype === "application/octet-stream" ||
      /\.(mp4|mov|mkv|webm|avi|flv|wmv|m4v)$/i.test(file.originalname);
    cb(ok ? null : new Error("only video files are allowed"), ok);
  },
});

function extname(p) {
  const i = p.lastIndexOf(".");
  return i > -1 ? p.slice(i) : "";
}
