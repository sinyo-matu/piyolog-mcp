# セキュリティ方針

piyo-mcp は乳児の健康記録を扱うセルフホスト MCP です。公開 Issue にフィード URL、パスワード、実記録、子どもの実名を貼らないでください。

## 想定する脅威モデル

- パスワードを知っている人は、OAuth 連携後（および Bearer にパスワードを直接載せた場合）保存済みの全記録を読めます。ユーザーごとのアカウントはありません。
- 28日を過ぎた記録は `OAUTH_KV` に残ります。フィード URL を失効しても、こちらに保存済みの記録は消えません。
- Data Feed URL が漏れると、この Worker を経由しなくても記録を取得できることがあります。URL は secret として扱ってください。
- Dynamic Client Registration は公開エンドポイントです。OAuth クライアントの無制限登録やトークンエンドポイントへの総当たりは、Cloudflare 側のレート制限に依存します。

## 運用上の注意

- `AUTH_PASSWORD` / `COOKIE_ENCRYPTION_KEY` / `PIYOLOG_FEED_URL` / `CHILD_NAME` は Worker secrets に置く。リポジトリやスクリーンショットに出さない。CI から載せる場合は GitHub Actions の repository secrets に同じ名前で入れる。
- パスワードやフィード URL が漏れたら、両方をローテし、必要なら OAuth KV の grant と `archive:` の記録を消す。
- 母乳量は記録された ml だけを使い、授乳時間から推定しません。

## 報告

脆弱性は GitHub Issue ではなく、リポジトリの Security advisory、またはメンテナの連絡先へ非公開で報告してください。
