import crypto from "crypto";
import { dbEngine, parseDeviceInfo } from "./db";
import { syncManager } from "./sync";

const SECRET_SALT = process.env.AUTH_SECRET_SALT || "siaramaina_clan_informatics_secret_2026";

export interface AppUser {
  uid: string;
  id?: string;
  email: string;
  displayName: string;
  role: "admin" | "editor" | "viewer" | "headteacher" | "teacher" | "parent" | "inspector";
  institution?: string;
  branch?: string;
  passwordHash?: string;
  salt?: string;
  createdAt: string;
  lastLogin?: string;
  status?: "active" | "inactive";
  active?: boolean;
  provider?: "password" | "google" | "yahoo" | "demo";
}

export function isStandardEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  if (clean.length < 6 || clean.length > 254) return false;
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return regex.test(clean);
}

export function validateEmailOrThrow(
  email: string,
  actionType: string,
  ip: string = "127.0.0.1",
  ua: string = ""
): string {
  const clean = (email || "").trim().toLowerCase();
  const dev = parseDeviceInfo(ua, ip);

  if (!isStandardEmail(clean)) {
    dbEngine.logSecurityEvent({
      eventType: "LOGIN_FAILED",
      email: clean || "invalid-format",
      ipAddress: ip,
      userAgent: ua,
      deviceType: dev.deviceType,
      browser: dev.browser,
      os: dev.os,
      status: "BLOCKED",
      reason: `NON_STANDARD_EMAIL_REJECTED: "${clean}" fails RFC 5322 format`,
    });

    syncManager.broadcast("security_alert", {
      type: "NON_STANDARD_EMAIL_BLOCKED",
      email: clean || "empty",
      ipAddress: ip,
      timestamp: new Date().toISOString(),
      message: `Security Shield blocked nonstandard email login attempt: "${clean}"`,
    });

    throw new Error(
      "NON_STANDARD_EMAIL: Please provide a valid standard email address (e.g. user@domain.com)."
    );
  }
  return clean;
}

export function hashPassword(pass: string, salt: string): string {
  return crypto.createHmac("sha256", salt).update(pass).digest("hex");
}

export function generateToken(user: AppUser): string {
  const payload = {
    uid: user.uid || (user as any).id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    branch: user.branch,
    iat: Date.now(),
    exp: Date.now() + 30 * 86400000,
  };
  const str = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", SECRET_SALT).update(str).digest("hex");
  return Buffer.from(str).toString("base64") + "." + sig;
}

export function verifyToken(token: string): AppUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [b64, sig] = parts;
    const str = Buffer.from(b64, "base64").toString("utf-8");
    if (crypto.createHmac("sha256", SECRET_SALT).update(str).digest("hex") !== sig) {
      return null;
    }
    const payload = JSON.parse(str);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function authenticateWithPassword(
  email: string,
  pass: string,
  ip: string = "127.0.0.1",
  ua: string = ""
) {
  const cleanEmail = validateEmailOrThrow(email, "LOGIN", ip, ua);
  const dev = parseDeviceInfo(ua, ip);
  const users = dbEngine.getCollection("users") as AppUser[];
  const user = users.find((u) => u.email && u.email.toLowerCase() === cleanEmail);

  if (!user || (user.passwordHash && hashPassword(pass, user.salt || "") !== user.passwordHash)) {
    dbEngine.logSecurityEvent({
      eventType: "LOGIN_FAILED",
      email: cleanEmail,
      ipAddress: ip,
      userAgent: ua,
      deviceType: dev.deviceType,
      browser: dev.browser,
      os: dev.os,
      status: "FAILED",
      reason: "INVALID_CREDENTIALS",
    });

    syncManager.broadcast("login_notification", {
      type: "LOGIN_FAILED",
      email: cleanEmail,
      status: "FAILED",
      timestamp: new Date().toISOString(),
    });

    throw new Error("INVALID_CREDENTIAL: Incorrect email or password.");
  }

  user.lastLogin = new Date().toISOString();
  await dbEngine.save();

  dbEngine.logSecurityEvent({
    eventType: "LOGIN_SUCCESS",
    email: cleanEmail,
    displayName: user.displayName,
    role: user.role,
    ipAddress: ip,
    userAgent: ua,
    deviceType: dev.deviceType,
    browser: dev.browser,
    os: dev.os,
    status: "SUCCESS",
  });

  syncManager.broadcast("login_notification", {
    type: "LOGIN_SUCCESS",
    email: cleanEmail,
    displayName: user.displayName,
    role: user.role,
    status: "SUCCESS",
    timestamp: new Date().toISOString(),
  });

  return { user: sanitizeUser(user), token: generateToken(user) };
}

export function sanitizeUser(user: AppUser): AppUser {
  const clone = { ...user };
  delete clone.passwordHash;
  delete clone.salt;
  return clone;
}
