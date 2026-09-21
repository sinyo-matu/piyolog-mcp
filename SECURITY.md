# セキュリティ方針

piyo-mcp は乳児の健康記録を扱うセルフホスト MCP です。公開 Issue にフィード URL、家族パスワード、実記録、子どもの実名を貼らないでください。

## 想定する脅威モデル

- 家族パスワードを知っている人は、OAuth 連携後（および Bearer にパスワードを直接載せた場合）フィード期間内の全記録を読めます。ユーザーごとのアカウントはありません。
- Data Feed URL が漏れると、この Worker を経由しなくても記録を取得できることがあります。URL は secret として扱ってください。
- Dynamic Client Registration は公開エンドポイントです。OAuth クライアントの無制限登録やトークンエンドポイントへの総当たりは、Cloudflare 側のレート制限に依存します。

## 運用上の注意

- `FAMILY_PASSWORD` / `COOKIE_ENCRYPTION_KEY` / `PIYOLOG_FEED_URL` は Worker secrets に置く。リポジトリやスクリーンショットに出さない。
- パスワードやフィード URL が漏れたら、両方をローテし、必要なら OAuth KV の grant を消す。
- 母乳量は記録された ml だけを使い、授乳時間から推定しません。

## 報告

脆弱性は GitHub Issue ではなく、リポジトリの Security advisory、またはメンテナの連絡先へ非公開で報告してください。
