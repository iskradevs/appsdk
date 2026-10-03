import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";

const issuer = "iskra-apps";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ViewerIdentity {
  readonly profileId: string;
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly displayName: string;
}

export interface VerifyViewerOptions {
  readonly appId: string;
  readonly jwks?: JSONWebKeySet;
  readonly jwksUrl?: string;
  readonly apiUrl?: string;
}

export async function verifyViewerIdentity(token: string, options: VerifyViewerOptions): Promise<ViewerIdentity> {
  if (!uuidPattern.test(options.appId)) {
    throw new Error("appId должен быть UUID");
  }
  const header = decodeProtectedHeader(token);
  if (header.alg !== "EdDSA" || typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("viewer JWT использует недопустимый algorithm или kid");
  }

  const keySet = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(options.jwksUrl ?? `${trimURL(required(options.apiUrl, "apiUrl"))}/api/apps/jwks`));
  const { payload, protectedHeader } = await jwtVerify(token, keySet, {
    algorithms: ["EdDSA"],
    issuer,
    audience: options.appId,
    clockTolerance: 30,
    maxTokenAge: "5m",
    requiredClaims: ["iat", "exp", "sub", "sid", "name", "org"],
  });
  if (protectedHeader.alg !== "EdDSA" || !Array.isArray(payload.aud) || payload.aud.length !== 1) {
    throw new Error("viewer JWT audience обязана содержать ровно одно приложение");
  }
  if (typeof payload.sub !== "string" || !uuidPattern.test(payload.sub)) {
    throw new Error("viewer JWT содержит невалидный sub");
  }
  const sid = payload.sid;
  if (typeof sid !== "string" || !uuidPattern.test(sid)) {
    throw new Error("viewer JWT содержит невалидный sid");
  }
  const org = payload.org;
  if (org !== null && (typeof org !== "string" || !uuidPattern.test(org))) {
    throw new Error("viewer JWT содержит невалидный org");
  }
  if (typeof payload.name !== "string") {
    throw new Error("viewer JWT содержит невалидное имя");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp <= payload.iat || payload.exp - payload.iat > 300) {
    throw new Error("viewer JWT содержит недопустимое окно жизни");
  }
  return { profileId: payload.sub, sessionId: sid, organizationId: org, displayName: payload.name };
}

function trimURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} обязателен`);
  return value;
}
