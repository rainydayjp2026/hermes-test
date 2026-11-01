// Gemini API（generateContent）で画像内の文字を判定・書き起こす。

export type OcrResult = { has_text: boolean; text: string; title: string };
export type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };

const PROMPT = `あなたはOCRエンジンです。画像に含まれる文字を判定し、書き起こしてください。
規則:
- 画像内の文字を、見えるとおりそのまま書き起こす。補完・要約・修正・翻訳はしない。
- 改行や段落の区切りはできる範囲で保つ。縦書きは上から下、右の列から左の列の順で読む。
- 読めない箇所は〔判読不能〕と書く。推測で埋めない。
- 意味のある文字（単語・数字・記号列）が無い場合は has_text を false、text を空文字にする。
- title には内容を表す短い日本語（20文字以内、ファイル名に使える文字のみ）を入れる。文字が無い場合は空文字。`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    has_text: { type: 'BOOLEAN' },
    text: { type: 'STRING' },
    title: { type: 'STRING' },
  },
  required: ['has_text', 'text', 'title'],
  propertyOrdering: ['has_text', 'text', 'title'],
};

export async function runOcr(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
): Promise<{ result: OcrResult; usage: Usage }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: PROMPT }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    throw new UpstreamError('gemini', res.status, await res.text());
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: Usage;
  };
  const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return { result: parseOcrJson(raw), usage: json.usageMetadata ?? {} };
}

export function parseOcrJson(raw: string): OcrResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('Gemini の応答が JSON ではありません');
  }
  const o = obj as Partial<OcrResult>;
  const text = typeof o.text === 'string' ? o.text : '';
  const hasText = o.has_text === true && text.trim() !== '';
  return { has_text: hasText, text: hasText ? text : '', title: typeof o.title === 'string' ? o.title : '' };
}

export class UpstreamError extends Error {
  service: string;
  status: number;
  detail: string;
  constructor(service: string, status: number, detail: string) {
    super(`${service} ${status}`);
    this.service = service;
    this.status = status;
    this.detail = detail;
  }
}
