// POST /scan : 画像を受け取り、Gemini で文字判定・書き起こし、文字があれば共有ドライブへ保存する。

import { getAccessToken } from './google-auth.ts';
import { runOcr, UpstreamError } from './gemini.ts';
import { jstStamp, sanitizeTitle, uploadFile } from './drive.ts';

export interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  SA_CLIENT_EMAIL: string;
  SA_PRIVATE_KEY: string;
  DRIVE_FOLDER_ID: string;
  APP_SHARED_TOKEN: string;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function tokenMatches(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname !== '/scan') return json(404, { error: 'not found' });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });

    const auth = req.headers.get('Authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!(await tokenMatches(given, env.APP_SHARED_TOKEN))) {
      return json(401, { error: 'unauthorized' });
    }

    let payload: { image_base64?: unknown; mime_type?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: 'JSON body が必要です' });
    }
    const imageBase64 = typeof payload.image_base64 === 'string' ? payload.image_base64 : '';
    const mimeType = typeof payload.mime_type === 'string' ? payload.mime_type : 'image/jpeg';
    if (!imageBase64) return json(400, { error: 'image_base64 がありません' });
    if (!ALLOWED_MIME.has(mimeType)) return json(400, { error: '未対応の画像形式です' });

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(imageBase64);
    } catch {
      return json(400, { error: 'image_base64 が不正です' });
    }
    if (bytes.length > MAX_IMAGE_BYTES) return json(413, { error: '画像が大きすぎます（5MBまで）' });

    const started = Date.now();
    try {
      const { result, usage } = await runOcr(env.GEMINI_API_KEY, env.GEMINI_MODEL, imageBase64, mimeType);

      let saved: { image_id: string; text_id: string } | null = null;
      if (result.has_text) {
        const token = await getAccessToken({
          clientEmail: env.SA_CLIENT_EMAIL,
          privateKeyPem: env.SA_PRIVATE_KEY,
        });
        const base = `${jstStamp(new Date())}_${sanitizeTitle(result.title)}`;
        const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
        const [imageId, textId] = await Promise.all([
          uploadFile(token, env.DRIVE_FOLDER_ID, `${base}.${ext}`, mimeType, bytes),
          uploadFile(token, env.DRIVE_FOLDER_ID, `${base}.txt`, 'text/plain', result.text),
        ]);
        saved = { image_id: imageId, text_id: textId };
      }

      // 画像・本文はログに出さない
      console.log(
        JSON.stringify({
          event: 'scan',
          has_text: result.has_text,
          saved: saved !== null,
          bytes: bytes.length,
          ms: Date.now() - started,
          usage,
        }),
      );
      return json(200, { ...result, saved });
    } catch (e) {
      if (e instanceof UpstreamError) {
        // detail には入力が含まれないことを前提に先頭だけ記録
        console.log(JSON.stringify({ event: 'upstream_error', service: e.service, status: e.status, detail: e.detail.slice(0, 500) }));
        const status = e.status === 429 ? 429 : 502;
        return json(status, { error: `${e.service} でエラーが発生しました（${e.status}）` });
      }
      console.log(JSON.stringify({ event: 'error', message: String(e).slice(0, 300) }));
      return json(500, { error: '内部エラー' });
    }
  },
} satisfies ExportedHandler<Env>;
