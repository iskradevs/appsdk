import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
type AppEnvironment = Readonly<Record<string, string | undefined>>;

const sessionTTLSeconds = 24 * 60 * 60;

export function appBasePath(env: AppEnvironment = process.env): string {
  const raw = env.APP_BASE_PATH;
  if (!raw || !raw.startsWith("/") || raw.includes("?") || raw.includes("#")) {
    throw new Error("APP_BASE_PATH обязан быть абсолютным URL path");
  }
  const normalized = posix.normalize(raw);
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}

export function appDataPath(relativePath: string, env: AppEnvironment = process.env): string {
  const root = env.DATA_DIR;
  if (!root || !posix.isAbsolute(root)) throw new Error("DATA_DIR обязан быть абсолютным путём");
  if (!relativePath || posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error("путь данных обязан оставаться внутри DATA_DIR");
  }
  return posix.join(root, relativePath);
}

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("пароль не должен быть пустым");
  const salt = randomBytes(16);
  const derived = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (n !== 32768 || r !== 8 || p !== 1 || salt.length !== 16 || expected.length !== 32) return false;
  const actual = await derive(password, salt, expected.length, { N: n, r, p, maxmem: 64 << 20 });
  return timingSafeEqual(actual, expected);
}

export function newSession(subject: string, secret: string, now = new Date()): string {
  if (!subject || !secret) throw new Error("subject и session secret обязательны");
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(now.getTime() / 1000) + sessionTTLSeconds, nonce: randomBytes(16).toString("base64url") })).toString("base64url");
  return `${payload}.${sessionMAC(payload, secret)}`;
}

export function verifySession(session: string, secret: string, now = new Date()): string | null {
  const [payload, signature, extra] = session.split(".");
  if (!payload || !signature || extra !== undefined || !secret) return null;
  const expected = sessionMAC(payload, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp <= Math.floor(now.getTime() / 1000)) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

function sessionMAC(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function derive(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}
