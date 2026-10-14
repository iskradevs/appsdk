import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { verifyViewerIdentity } from "../dist/viewer.js";

const appId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";

function token(override = {}, headerOverride = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "iskra-apps",
    sub: profileId,
    aud: [appId],
    sid,
    org: null,
    name: "Иван",
    iat: now,
    exp: now + 300,
    ...override,
  };
  const header = { alg: "EdDSA", kid: "test", typ: "JWT", ...headerOverride };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "EdDSA", use: "sig" }] };

test("viewer JWT принимает только EdDSA, issuer и единственную app audience", async () => {
  const identity = await verifyViewerIdentity(token(), { appId, jwks });
  assert.deepEqual(identity, { profileId, sessionId: sid, organizationId: null, displayName: "Иван" });

  await assert.rejects(() => verifyViewerIdentity(token({ iss: "other" }), { appId, jwks }));
  await assert.rejects(() => verifyViewerIdentity(token({ aud: [appId, "other"] }), { appId, jwks }));
  await assert.rejects(() => verifyViewerIdentity(token({}, { alg: "HS256" }), { appId, jwks }));
});

test("viewer JWT принимает подписанные UUID тестовых профилей и организаций CORE", async () => {
  const sub = "00000000-0000-0000-8000-000000000001";
  const org = "00000000-0000-0000-1000-000000000001";
  const identity = await verifyViewerIdentity(token({ sub, org }), { appId, jwks });
  assert.deepEqual(identity, {
    profileId: sub, sessionId: sid, organizationId: org, displayName: "Иван",
  });
  const privateProfile = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    (await verifyViewerIdentity(token({ sub: privateProfile }), { appId, jwks })).profileId,
    privateProfile,
  );
});

test("viewer JWT отклоняет повреждённые идентификаторы в подписанных claims", async () => {
  for (const claim of ["sub", "sid", "org"]) {
    for (const value of ["not-a-uuid", "00000000000000008000000000000001", "00000000-0000-0000-8000-00000000000z"]) {
      await assert.rejects(() => verifyViewerIdentity(token({ [claim]: value }), { appId, jwks }));
    }
  }
});
