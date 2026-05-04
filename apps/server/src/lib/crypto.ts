import crypto from "node:crypto";
import { env } from "../env.js";

const algorithm = "aes-256-gcm";
const key = crypto.createHash("sha256").update(env.SESSION_SECRET).digest();

export function encryptString(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptString(payload: string) {
  const [ivPart, tagPart, encryptedPart] = payload.split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Invalid encrypted payload");
  }

  const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
