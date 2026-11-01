// app.json をベースに、接続先とトークンを環境変数（.env）から注入する。
// トークンをリポジトリにコミットしないための分離。
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    workerUrl: process.env.OCR_WORKER_URL,
    appToken: process.env.OCR_APP_TOKEN,
  },
});
