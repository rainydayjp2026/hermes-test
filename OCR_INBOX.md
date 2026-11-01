# OCR Inbox（試作）

Android のカメラで撮影 → Cloudflare Worker 経由で Gemini API が文字を判定・書き起こし → 文字があれば画像（.jpg）とテキスト（.txt）を Google Workspace の**共有ドライブ**にサービスアカウントで保存する。

```
app/     Expo（SDK 58, TypeScript）。撮影・縮小・送信・結果表示のみ。鍵は持たない
worker/  Cloudflare Worker。POST /scan で Gemini 呼び出しと Drive 保存を行う
```

## 1. Google 側の準備

1. **共有ドライブ**を作成し、サービスアカウントのメールアドレス（`…@….iam.gserviceaccount.com`）を「コンテンツ管理者」で追加する。
   - マイドライブのフォルダは不可（サービスアカウントにストレージ容量がないため失敗する）。
   - 組織外メンバー追加が制限されている場合は管理コンソールで許可が必要。
2. 保存先フォルダ ID（共有ドライブ直下ならドライブ ID）を URL から控える。
3. サービスアカウントが属する GCP プロジェクトで **Google Drive API** を有効化する。
4. サービスアカウントの鍵（JSON）を発行する。既存 SA を流用する場合も、この Worker 専用の鍵を新規発行する。
5. Gemini API キーは**課金が有効なプロジェクト**で発行する（無料枠だと入力データが製品改善に使われ得る）。モデル ID は AI Studio の一覧の表記に合わせ `worker/wrangler.jsonc` の `GEMINI_MODEL` に設定する。

## 2. Worker

```bash
cd worker
npm install
npm test            # 単体テスト（外部 API はモック）
npx wrangler login
```

Secrets を登録（`SA_PRIVATE_KEY` は鍵 JSON の `private_key` の値をそのまま）:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SA_CLIENT_EMAIL
npx wrangler secret put SA_PRIVATE_KEY
npx wrangler secret put DRIVE_FOLDER_ID
npx wrangler secret put APP_SHARED_TOKEN   # 例: openssl rand -hex 32 の出力
```

```bash
npx wrangler deploy
```

ローカル実行は `.dev.vars.example` を `.dev.vars` にコピーして値を入れ、`npm run dev`。

動作確認:

```bash
curl -sS -X POST "$WORKER_URL/scan" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"image_base64\":\"$(base64 -w0 sample.jpg)\",\"mime_type\":\"image/jpeg\"}"
```

応答: `{ has_text, text, title, saved: { image_id, text_id } | null }`。ファイル名は `YYYYMMDD-HHmmss_<title>.jpg/.txt`（JST）。

## 3. アプリ（Android 実機）

```bash
cd app
npm install
cp .env.example .env    # OCR_WORKER_URL と OCR_APP_TOKEN を設定
npx expo start
```

Android 端末の Expo Go で QR を読み取る（同一 LAN でない場合は `npx expo start --tunnel`）。ネイティブモジュールは Expo SDK 同梱のもののみなので Development Build は不要。

## 注意

- `APP_SHARED_TOKEN` はアプリから抽出可能。自分だけが使う試作限定。配布前に端末認証（Play Integrity 等）へ置き換える。
- Worker のログには画像・本文を出さない（has_text / 保存可否 / サイズ / 処理時間 / トークン数のみ）。
- 共有ドライブのメンバー全員が保存画像を閲覧できる。メンバーは最小限に。
- 書き起こしは生成 AI によるため誤りを含み得る。
- 将来のログイン＋フォルダ選択は `worker/src/google-auth.ts` の `getAccessToken` を差し替える前提で分離済み。
