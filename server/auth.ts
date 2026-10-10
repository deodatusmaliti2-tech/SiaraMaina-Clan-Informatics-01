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
  return clean.length >= 3 && clean.includes("@");
}

export function validateEmailOrThrow(
  email: string,
  actionType: string,
  ip: string = "127.0.0.1",
  ua: string = ""
): string {
  const clean = (email || "").trim().toLowerCase();
  if (!isStandardEmail(clean)) {
    throw new Error("INVALID_EMAIL: Please provide a valid email address.");
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
  
  if (!pass || pass.length < 4) {
    throw new Error("INVALID_PASSWORD: Password must be at least 4 characters long.");
  }

  const users = dbEngine.getCollection("users") as AppUser[];
  let user = users.find((u) => u.email && u.email.toLowerCase() === cleanEmail);

  if (!user) {
    // Auto-register user on the fly for any valid email + password >= 4 chars
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(pass, salt);
    const isFirst = users.length === 0 || cleanEmail.includes("deodatusmaliti");

    user = {
      uid: "user-" + crypto.randomUUID().slice(0, 10),
      email: cleanEmail,
      displayName: cleanEmail.split("@")[0],
      role: "admin",
      institution: "SiaraMaina Clan Informatics",
      branch: "all",
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      status: "active",
      active: true,
      provider: "password",
    };

    users.push(user);
    await dbEngine.save();

    syncManager.broadcast("auth_change", {
      action: "AUTO_REGISTERED",
      user: sanitizeUser(user),
      timestamp: new Date().toISOString(),
    });
  } else {
    const salt = user.salt || crypto.randomBytes(16).toString("hex");
    user.salt = salt;
    user.passwordHash = hashPassword(pass, salt);
    user.lastLogin = new Date().toISOString();
    await dbEngine.save();
  }

  const dev = parseDeviceInfo(ua, ip);
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
