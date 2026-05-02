import { SignJWT, jwtVerify, importPKCS8, importSPKI, type KeyLike } from 'jose';
import { config } from '../config.js';
import { randomUUID } from 'crypto';

const ALG = 'EdDSA';

let _privateKey: KeyLike | null = null;
let _publicKey: KeyLike | null = null;

async function getPrivateKey(): Promise<KeyLike> {
  if (!_privateKey) {
    _privateKey = (await importPKCS8(config.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), ALG)) as KeyLike;
  }
  return _privateKey;
}

async function getPublicKey(): Promise<KeyLike> {
  if (_publicKey) return _publicKey;

  if (config.JWT_PUBLIC_KEY_BASE64) {
    const base64 = config.JWT_PUBLIC_KEY_BASE64.trim();
    const pem = base64.includes('BEGIN PUBLIC KEY')
      ? base64
      : `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    _publicKey = (await importSPKI(pem, ALG)) as KeyLike;
    return _publicKey;
  }

  // Fallback: use private key for verification (works with jose for symmetric flows
  // but not Ed25519). Operators should always set JWT_PUBLIC_KEY_BASE64 in production.
  _publicKey = await getPrivateKey();
  return _publicKey;
}

export async function getPublicKeyBase64(): Promise<string> {
  return config.JWT_PUBLIC_KEY_BASE64 ?? '';
}

export async function signAccessToken(payload: {
  sub: string;
  email: string;
  tier: string;
  features: string[];
}): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ email: payload.email, tier: payload.tier, features: payload.features })
    .setProtectedHeader({ alg: ALG, kid: config.JWT_PUBLIC_KEY_ID })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .setIssuer(config.PUBLIC_URL)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<{
  sub: string; email: string; tier: string; features: string[];
}> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: config.PUBLIC_URL,
    algorithms: [ALG],
  });
  return {
    sub: payload.sub as string,
    email: payload['email'] as string,
    tier: payload['tier'] as string,
    features: payload['features'] as string[],
  };
}

export async function signLicenseJwt(payload: {
  sub: string;
  device: string;
  tier: string;
  features: string[];
  paymentPastDue: boolean;
}): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({
    device: payload.device,
    tier: payload.tier,
    features: payload.features,
    offline_grace_seconds: 259200,
    payment_past_due: payload.paymentPastDue,
  })
    .setProtectedHeader({ alg: ALG, kid: config.JWT_PUBLIC_KEY_ID })
    .setSubject(payload.sub)
    .setAudience('airwaves-extension')
    .setIssuedAt()
    .setExpirationTime('6h')
    .setJti(randomUUID())
    .setIssuer(config.PUBLIC_URL)
    .sign(key);
}

export async function verifyLicenseJwt(token: string): Promise<{
  sub: string; device: string; tier: string; features: string[];
  payment_past_due: boolean; offline_grace_seconds: number;
}> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: config.PUBLIC_URL,
    audience: 'airwaves-extension',
    algorithms: [ALG],
  });
  return {
    sub: payload.sub as string,
    device: payload['device'] as string,
    tier: payload['tier'] as string,
    features: payload['features'] as string[],
    payment_past_due: payload['payment_past_due'] as boolean,
    offline_grace_seconds: payload['offline_grace_seconds'] as number,
  };
}
