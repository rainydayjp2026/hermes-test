import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, timingSafeEqual } from 'node:crypto';
import { signJwt } from '../src/google-auth.ts';
import { parseOcrJson } from '../src/gemini.ts';
import { jstStamp, sanitizeTitle } from '../src/drive.ts';
import worker from '../src/index.ts';

// Workers 固有 API の補完
(crypto.subtle as any).timingSafeEqual ??= (a: ArrayBuffer, b: ArrayBuffer) =>
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function makeKey() {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  // 鍵 JSON と同じく \n をエスケープした 1 行形式
  const pem = `-----BEGIN PRIVATE KEY-----\\n${pkcs8.match(/.{1,64}/g)!.join('\\n')}\\n-----END PRIVATE KEY-----\\n`;
  return { pem, publicKey: kp.publicKey };
}

test('signJwt: 検証可能な RS256 JWT を生成する', async () => {
  const { pem, publicKey } = await makeKey();
  const jwt = await signJwt({ clientEmail: 'sa@x.iam.gserviceaccount.com', privateKeyPem: pem }, 1000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, 'sa@x.iam.gserviceaccount.com');
  assert.equal(claims.exp, 4600);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive');
  const ok = await webcrypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok);
});

test('parseOcrJson: 空テキストは has_text=false に正規化', () => {
  assert.deepEqual(parseOcrJson('{"has_text":true,"text":"  ","title":"x"}'), { has_text: false, text: '', title: 'x' });
  assert.equal(parseOcrJson('{"has_text":true,"text":"abc","title":"t"}').has_text, true);
  assert.throws(() => parseOcrJson('not json'));
});

test('sanitizeTitle / jstStamp', () => {
  assert.equal(sanitizeTitle('a/b:c*?"<>|'), 'abc');
  assert.equal(sanitizeTitle('  '), 'untitled');
  assert.equal(jstStamp(new Date('2026-11-01T15:04:05Z')), '20261102-000405');
});

async function setup(geminiText: string) {
  const { pem } = await makeKey();
  const env = {
    GEMINI_API_KEY: 'k',
    GEMINI_MODEL: 'm',
    SA_CLIENT_EMAIL: 'sa@x.iam.gserviceaccount.com',
    SA_PRIVATE_KEY: pem,
    DRIVE_FOLDER_ID: 'folder1',
    APP_SHARED_TOKEN: 'secret',
  };
  const calls: { url: string; body?: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body instanceof Blob ? await init.body.text() : init?.body?.toString();
    calls.push({ url, body });
    if (url.includes('generativelanguage')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: geminiText }] } }], usageMetadata: { totalTokenCount: 10 } });
    }
    if (url.includes('oauth2')) return Response.json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('upload/drive')) return Response.json({ id: `id${calls.length}` });
    throw new Error(url);
  }) as typeof fetch;
  const req = (token: string) =>
    new Request('https://w/scan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: Buffer.from('fakejpeg').toString('base64'), mime_type: 'image/jpeg' }),
    });
  return { env, calls, req };
}

test('/scan: 文字ありなら共有ドライブへ jpg と txt を保存', async () => {
  const { env, calls, req } = await setup('{"has_text":true,"text":"こんにちは","title":"挨拶"}');
  const res = await worker.fetch(req('secret'), env as any);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.text, 'こんにちは');
  assert.ok(body.saved.image_id && body.saved.text_id);
  const uploads = calls.filter((c) => c.url.includes('upload/drive'));
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((u) => u.url.includes('supportsAllDrives=true')));
  assert.ok(uploads.every((u) => u.body!.includes('"parents":["folder1"]')));
  assert.ok(uploads.some((u) => u.body!.includes('_挨拶.txt')));
});

test('/scan: 文字なしなら保存しない', async () => {
  const { env, calls, req } = await setup('{"has_text":false,"text":"","title":""}');
  const res = await worker.fetch(req('secret'), env as any);
  const body: any = await res.json();
  assert.equal(body.has_text, false);
  assert.equal(body.saved, null);
  assert.equal(calls.filter((c) => c.url.includes('drive')).length, 0);
});

test('/scan: トークン不一致は 401', async () => {
  const { env, req } = await setup('{}');
  const res = await worker.fetch(req('wrong'), env as any);
  assert.equal(res.status, 401);
});
