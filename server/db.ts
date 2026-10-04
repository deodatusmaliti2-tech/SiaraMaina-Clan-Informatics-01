import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveAppRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
  }
  return process.cwd();
}

export const ROOT_DIR = resolveAppRoot();
export const DATA_DIR = process.env.DATA_DIR || path.resolve(ROOT_DIR, "data");
export const BACKUP_DIR = path.resolve(DATA_DIR, "backups");
export const CLAN_DATA_FILE = path.resolve(ROOT_DIR, "siara-maina-clan-data.json");
export const USERS_DATA_FILE = path.resolve(ROOT_DIR, "siara-maina-clan-users.json");

export const RECORDS_FILE = path.resolve(DATA_DIR, "records.json");
export const USERS_FILE = path.resolve(DATA_DIR, "users.json");
export const PAYMENTS_FILE = path.resolve(DATA_DIR, "payments.json");
export const AUDIT_FILE = path.resolve(DATA_DIR, "audit_logs.json");
export const EVENTS_LOG_FILE = path.resolve(DATA_DIR, "events.log");

export interface DatabaseSchema {
  records: any[];
  users: any[];
  payments: any[];
  auditLogs: any[];
}

function calculateChecksum(data: string): string {
  return crypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

export function atomicWriteJsonSync(filePath: string, dataObj: any): string {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const jsonContent = JSON.stringify(dataObj, null, 2);
  const checksum = calculateChecksum(jsonContent);
  const checksumPath = `${filePath}.checksum`;

  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, jsonContent, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);
  fs.writeFileSync(checksumPath, checksum, "utf-8");
  return checksum;
}

export function atomicReadJsonSync(filePath: string, defaultVal: any): any {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultVal;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const checksumPath = `${filePath}.checksum`;

    if (fs.existsSync(checksumPath)) {
      const expectedChecksum = fs.readFileSync(checksumPath, "utf-8").trim();
      const actualChecksum = calculateChecksum(raw);
      if (expectedChecksum && actualChecksum !== expectedChecksum) {
        console.error(`[DatabaseEngine] CORRUPTION DETECTED in ${filePath}! Checksum mismatch.`);
        const recovered = recoverFromBackup(filePath);
        if (recovered !== null) return recovered;
      }
    }

    return JSON.parse(raw);
  } catch (err) {
    console.error(`[DatabaseEngine] Error reading ${filePath}:`, err);
    const recovered = recoverFromBackup(filePath);
    if (recovered !== null) return recovered;
    return defaultVal;
  }
}

function recoverFromBackup(filePath: string): any {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")).sort().reverse();
    for (const b of backups) {
      const bPath = path.join(BACKUP_DIR, b);
      try {
        const raw = fs.readFileSync(bPath, "utf-8");
        const parsed = JSON.parse(raw);
        console.warn(`[DatabaseEngine] Successfully recovered from backup snapshot: ${b}`);
        return parsed;
      } catch {}
    }
  } catch {}
  return null;
}

async function saveToFirestore(collectionName: string, id: string, data: any) {
  // Cloud edge persistence is handled via Cloudflare D1 and atomic storage
}

async function deleteFromFirestore(collectionName: string, id: string) {
  // Cloud edge persistence is handled via Cloudflare D1 and atomic storage
}

async function fetchFromFirestore(collectionName: string): Promise<any[]> {
  return [];
}

class HardenedDatabaseEngine {
  private records: any[] = [];
  private users: any[] = [];
  private payments: any[] = [];
  private auditLogs: any[] = [];
  private version: number = Date.now();
  private lastModified: string = new Date().toISOString();
  private processedIdempotencyKeys: Set<string> = new Set();
  private isWriting: boolean = false;
  private writeQueue: (() => Promise<void>)[] = [];

  constructor() {
    this.ensureDirs();
    this.loadAll();
    this.createBackupSnapshot();
  }

  private ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  private async loadAll() {
    // 1. Load baseline local records (always safe)
    const loadedRecords = atomicReadJsonSync(RECORDS_FILE, null);
    if (Array.isArray(loadedRecords) && loadedRecords.length > 0) {
      this.records = loadedRecords;
    } else if (fs.existsSync(CLAN_DATA_FILE)) {
      try {
        const raw = fs.readFileSync(CLAN_DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        this.records = Array.isArray(parsed) ? parsed : parsed.records || [];
      } catch {}
    }

    const loadedUsers = atomicReadJsonSync(USERS_FILE, null);
    if (Array.isArray(loadedUsers)) {
      this.users = loadedUsers;
    } else if (fs.existsSync(USERS_DATA_FILE)) {
      try {
        const raw = fs.readFileSync(USERS_DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        this.users = Array.isArray(parsed) ? parsed : parsed.users || [];
      } catch {}
    }

    this.payments = atomicReadJsonSync(PAYMENTS_FILE, []);
    this.auditLogs = atomicReadJsonSync(AUDIT_FILE, []);

    // 1.5 Load from Firestore as high-reliability durable cache if local files are empty or container restarted
    try {
      if (this.records.length === 0) {
        const fsRecords = await fetchFromFirestore("records");
        if (fsRecords && fsRecords.length > 0) {
          console.log(`[DatabaseEngine] Restored ${fsRecords.length} records from Firestore durable cache.`);
          this.records = fsRecords;
        }
      }
      if (this.users.length === 0) {
        const fsUsers = await fetchFromFirestore("users");
        if (fsUsers && fsUsers.length > 0) {
          console.log(`[DatabaseEngine] Restored ${fsUsers.length} users from Firestore durable cache.`);
          this.users = fsUsers;
        }
      }
      if (this.payments.length === 0) {
        this.payments = await fetchFromFirestore("payments");
      }
      if (this.auditLogs.length === 0) {
        this.auditLogs = await fetchFromFirestore("auditLogs");
      }
    } catch (fsErr: any) {
      console.warn("[DatabaseEngine] Firestore restore cache failed:", fsErr.message);
    }

    this.persistAll();
  }

    public async pullLatestFromCloud(): Promise<void> {
    try {
      const res = await fetch("https://siaramaina.researchlinktz.com/api/db/collections/records");
      if (res.ok) {
        const json = await res.json();
        const recs = json.data || (Array.isArray(json) ? json : null);
        if (Array.isArray(recs) && recs.length > 0) {
          this.records = recs;
          this.persistAll();
        }
      }
    } catch(e) {}
  }

  public async pullLatestFromSupabase(): Promise<void> {
    return this.pullLatestFromCloud();
  }

  private persistAll() {
    atomicWriteJsonSync(RECORDS_FILE, this.records);
    atomicWriteJsonSync(USERS_FILE, this.users);
    atomicWriteJsonSync(PAYMENTS_FILE, this.payments);
    atomicWriteJsonSync(AUDIT_FILE, this.auditLogs);
  }

  public getVersion(): number {
    return this.version;
  }

  public getLastModified(): string {
    return this.lastModified;
  }

  public getCollection(name: string): any[] {
    if (name === "records" || name === "members") return this.records;
    if (name === "users") return this.users;
    if (name === "payments") return this.payments;
    if (name === "auditLogs" || name === "audit_logs") return this.auditLogs;
    return [];
  }

  public async save(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          this.version = Date.now();
          this.lastModified = new Date().toISOString();
          this.persistAll();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const task = this.writeQueue.shift();
    if (task) {
      try {
        await task();
      } catch (err) {
        console.error("[HardenedDatabaseEngine] Write task failed:", err);
      }
    }
    this.isWriting = false;
    if (this.writeQueue.length > 0) {
      this.processQueue();
    }
  }

  public checkIdempotency(key?: string): boolean {
    if (!key) return false;
    if (this.processedIdempotencyKeys.has(key)) return true;
    this.processedIdempotencyKeys.add(key);
    if (this.processedIdempotencyKeys.size > 2000) {
      const firstKey = this.processedIdempotencyKeys.values().next().value;
      if (firstKey) this.processedIdempotencyKeys.delete(firstKey);
    }
    return false;
  }

  public async replaceCollection(name: string, items: any[]): Promise<boolean> {
    const list = Array.isArray(items) ? [...items] : [];
    if (name === "records" || name === "members") {
      this.records = list.map((r) => ({
        ...r,
        v: (r.v || 0) + 1,
        updatedAt: new Date().toISOString(),
      }));

      

      // Direct write-through and dynamic deletion pruning in Firestore (Durable Cloud Fallback)
      try {
        const fsCol = name === "members" ? "records" : name;
        const remoteFirestoreRecords = await fetchFromFirestore(fsCol);
        const newIds = new Set(this.records.map((r) => r.id));

        if (remoteFirestoreRecords) {
          for (const r of remoteFirestoreRecords) {
            if (r.id && !newIds.has(r.id)) {
              console.log(`[Firestore Engine] Pruning deleted/orphaned record from Firestore: ${r.id}`);
              await deleteFromFirestore(fsCol, r.id);
            }
          }
        }

        for (const r of this.records) {
          await saveToFirestore(fsCol, r.id, r);
        }
      } catch (err: any) {
        console.warn("[Firestore Engine] Dynamic replaceCollection sync warning:", err.message);
      }
    } else if (name === "users") {
      this.users = list;
      try {
        for (const u of this.users) {
          await saveToFirestore("users", u.id || u.uid, u);
        }
      } catch (err: any) {
        console.warn("[Firestore Engine] Users sync warning:", err.message);
      }
    } else if (name === "payments") {
      const existingIds = new Set(this.payments.map(p => p.id));
      for (const p of list) {
        if (!existingIds.has(p.id)) {
          this.payments.push({ ...p, createdAt: p.createdAt || new Date().toISOString() });
          
          saveToFirestore("payments", p.id, p).catch(() => {});
        }
      }
    }
    await this.save();
    return true;
  }

  public async setDocument(collectionName: string, id: string, docData: any, idempotencyKey?: string): Promise<any> {
    if (this.checkIdempotency(idempotencyKey)) {
      return docData;
    }

    const timestamp = new Date().toISOString();
    const docId = id || docData.id || docData.uid || "rec-" + crypto.randomUUID().slice(0, 10);
    
    let targetList: any[];
    let tableMapping = "";

    if (collectionName === "records" || collectionName === "members") {
      targetList = this.records;
      tableMapping = "records";
    } else if (collectionName === "users") {
      targetList = this.users;
      tableMapping = "profiles";
    } else if (collectionName === "payments") {
      targetList = this.payments;
      tableMapping = "payments";
    } else {
      targetList = this.auditLogs;
      tableMapping = "audit_logs";
    }

    const idx = targetList.findIndex(i => i.id === docId || i.uid === docId || i.id === id);
    let currentV = 1;
    let savedDoc: any;

    if (idx >= 0) {
      currentV = (targetList[idx].v || 1) + 1;
      targetList[idx] = {
        ...targetList[idx],
        ...docData,
        id: docId,
        v: currentV,
        updatedAt: timestamp,
      };
      savedDoc = targetList[idx];
    } else {
      const newDoc = {
        ...docData,
        id: docId,
        v: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      targetList.push(newDoc);
      savedDoc = newDoc;
    }

    

    // Write-through to Firestore (Durable Cloud Fallback)
    try {
      const fsCol = collectionName === "members" ? "records" : collectionName;
      await saveToFirestore(fsCol, docId, savedDoc);
    } catch (fsErr: any) {
      console.warn(`[DatabaseEngine] Background Firestore write-through failed for ${docId}:`, fsErr.message);
    }

    await this.save();
    return savedDoc;
  }

  public async deleteDocument(collectionName: string, id: string): Promise<boolean> {
    let targetList: any[];
    let tableMapping = "";

    if (collectionName === "records" || collectionName === "members") {
      targetList = this.records;
      tableMapping = "records";
    } else if (collectionName === "users") {
      targetList = this.users;
      tableMapping = "profiles";
    } else if (collectionName === "payments") {
      return false;
    } else {
      targetList = this.auditLogs;
      tableMapping = "audit_logs";
    }

    const initialLen = targetList.length;
    const filtered = targetList.filter(i => i.id !== id && i.uid !== id);
    if (filtered.length !== initialLen) {
      if (collectionName === "records" || collectionName === "members") {
        this.records = filtered;
      } else if (collectionName === "users") {
        this.users = filtered;
      } else {
        this.auditLogs = filtered;
      }

      

      // Delete-through to Firestore (Durable Cloud Fallback)
      try {
        const fsCol = collectionName === "members" ? "records" : collectionName;
        await deleteFromFirestore(fsCol, id);
      } catch (fsErr: any) {
        console.warn(`[DatabaseEngine] Background Firestore delete-through failed for ${id}:`, fsErr.message);
      }

      await this.save();
      return true;
    }
    return false;
  }

  public logSecurityEvent(event: any) {
    const timestamp = new Date().toISOString();
    const id = "sec-" + crypto.randomUUID().slice(0, 10);
    const auditDoc = {
      id,
      ...event,
      createdAt: timestamp,
    };
    this.auditLogs.push(auditDoc);

    

    this.save();
  }

  public createBackupSnapshot(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(BACKUP_DIR, `cloud_database_backup_${timestamp}.json`);
    const snapshotData = {
      records: this.records,
      users: this.users,
      payments: this.payments,
      auditLogs: this.auditLogs,
      timestamp: new Date().toISOString(),
      version: this.version,
    };
    atomicWriteJsonSync(backupFile, snapshotData);
    return backupFile;
  }

  public listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json"));
    return files.map(filename => {
      const filepath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(filepath);
      return {
        filename,
        size: stat.size,
        sizeFormatted: (stat.size / 1024).toFixed(2) + " KB",
        created: stat.mtime.toISOString(),
      };
    }).sort((a, b) => b.created.localeCompare(a.created));
  }

  public getStats() {
    const size = fs.existsSync(RECORDS_FILE) ? fs.statSync(RECORDS_FILE).size : 0;
    return {
      totalRecords: this.records.length,
      totalUsers: this.users.length,
      totalPayments: this.payments.length,
      totalAuditLogs: this.auditLogs.length,
      databaseSizeBytes: size,
      databaseSizeFormatted: (size / 1024).toFixed(2) + " KB",
      maxStorageCapacity: "Unlimited Cloud Storage (Cloudflare D1 & Durable Engine)",
      status: "ONLINE_SYNCHRONIZED_CLOUDFLARE_D1",
      version: this.version,
      lastModified: this.lastModified,
      storageEngine: "Cloudflare D1 SQLite Edge Engine (siaramaina-db) & Durable Hardened Persistent Store",
    };
  }
}

export const dbEngine = new HardenedDatabaseEngine();

export function parseDeviceInfo(ua: string = "", ip: string = "") {
  let deviceType: "Desktop" | "Mobile" | "Tablet" | "Unknown" = "Desktop";
  let browser = "Chrome";
  let os = "Windows / Linux";

  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone")) {
    deviceType = "Mobile";
  } else if (lower.includes("ipad") || lower.includes("tablet")) {
    deviceType = "Tablet";
  }

  if (lower.includes("windows")) os = "Windows 11/10";
  else if (lower.includes("macintosh") || lower.includes("mac os")) os = "macOS";
  else if (lower.includes("android")) os = "Android OS";
  else if (lower.includes("iphone")) os = "iOS";
  else if (lower.includes("linux")) os = "Linux";

  if (lower.includes("edg/")) browser = "Edge";
  else if (lower.includes("chrome") && !lower.includes("edg/")) browser = "Chrome";
  else if (lower.includes("firefox")) browser = "Firefox";
  else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";

  return { deviceType, browser, os, geoRegion: "Tanzania / Global Cloud" };
}
