// Google Drive（共有ドライブ）へ multipart アップロードする。
// 共有ドライブでは supportsAllDrives=true が必須（無いと 404）。

import { UpstreamError } from './gemini.ts';

const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id';

export async function uploadFile(
  accessToken: string,
  folderId: string,
  name: string,
  mimeType: string,
  data: Uint8Array | string,
): Promise<string> {
  const boundary = `ocrinbox-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [folderId], mimeType });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    data,
    `\r\n--${boundary}--\r\n`,
  ]);
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new UpstreamError('drive', res.status, await res.text());
  return ((await res.json()) as { id: string }).id;
}

/** Drive で使えない/扱いにくい文字を除き、長さを制限する */
export function sanitizeTitle(title: string): string {
  const t = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .trim()
    .slice(0, 40);
  return t || 'untitled';
}

/** JST の YYYYMMDD-HHmmss */
export function jstStamp(date: Date): string {
  const j = new Date(date.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${j.getUTCFullYear()}${p(j.getUTCMonth() + 1)}${p(j.getUTCDate())}-` +
    `${p(j.getUTCHours())}${p(j.getUTCMinutes())}${p(j.getUTCSeconds())}`
  );
}
