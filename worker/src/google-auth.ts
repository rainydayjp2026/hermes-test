// サービスアカウント（JWT Bearer）でアクセストークンを取得する。
// Workers は Node ではないため googleapis は使わず WebCrypto で RS256 署名する。
// 将来ユーザー OAuth に切り替える場合は、この getAccessToken を差し替える。

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export type ServiceAccount = { clientEmail: string; privateKeyPem: string };

let cached: { token: string; expiresAt: number; email: string } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function signJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.clientEmail,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(sa.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cached && cached.email === sa.clientEmail && cached.expiresAt - 5 * 60_000 > now) {
    return cached.token;
  }
  const assertion = await signJwt(sa, Math.floor(now / 1000));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: now + json.expires_in * 1000, email: sa.clientEmail };
  return json.access_token;
}
