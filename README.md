# piyo-mcp

Cloudflare Workers 上の、ぴよログ Data Feed 向け **読み取り専用 MCP サーバー**です。Claude Desktop / ChatGPT などから授乳・睡眠・おむつの記録を分析できます。

このリポジトリは **自分でセルフホストする** ためのものです。他人の育児記録を集める SaaS ではありません。

## 注意

- 乳児の健康記録を LLM に渡します。同意と、ぴよログの利用規約を確認してください。
- パスワードを知っている人は、フィード期間内の全記録を読めます。
- サンプルデータや実名を Issue / PR / README に貼らないでください。
- ぴよログは第三者サービスです。本プロジェクトは非公式です。

## できること

MCP エンドポイント: `https://<your-worker>.workers.dev/mcp`

| ツール | 内容 |
| --- | --- |
| `get_today_records` | 今日（JST）の全記録 JSON |
| `get_latest_status` | 最新の授乳・睡眠・おむつ・体重 |
| `get_feeding_records` | 指定日の食事・授乳 |
| `get_all_records` | フィード期間内の全件（分析用） |
| `search` / `fetch` | 記録の検索と取得 |

母乳の ml は記録があるときだけ使い、授乳時間から推定しません。

認証は OAuth 2.1（PKCE S256、Dynamic Client Registration）。ChatGPT のツール一覧スキャンは `Accept: application/json` のみでも `tools/list` が通ります。Claude コネクタは未認証 `/mcp` に HTTP 401 と `WWW-Authenticate` を返します。

## セットアップ

必要なもの: Node.js 22+、Cloudflare アカウント、ぴよログ Data Feed の URL。

```bash
git clone <this-repo>
cd piyo-mcp
npm install
cp .dev.vars.example .dev.vars
```

`.dev.vars` を自分の値に書き換えます。

```
AUTH_PASSWORD=        # 認証用のパスワード
COOKIE_ENCRYPTION_KEY=  # openssl rand -hex 32
PIYOLOG_FEED_URL=       # ぴよログ Data Feed の URL
CHILD_NAME=Baby         # ツール説明に出す呼び名。実名は任意
AUTH_TTL_SECONDS=15552000  # 再認証までの秒。未設定なら半年（180日）
```

KV を作り、`wrangler.jsonc` の `OAUTH_KV.id` を自分の ID に差し替えます。メンテナの本番 ID が残っているので、フォークしたら必ず置き換えてください。

```bash
npx wrangler kv namespace create OAUTH_KV
npm run dev
```

本番:

```bash
npx wrangler secret put AUTH_PASSWORD
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put PIYOLOG_FEED_URL
npx wrangler secret put CHILD_NAME
npx wrangler deploy
```

接続 URL は `https://<name>.<account>.workers.dev/mcp` です。Claude Desktop のコネクタ、または ChatGPT のカスタム MCP / プラグインから追加し、パスワードで許可します。

## GitHub Actions でのデプロイ

`main` への push で type-check のあと、GitHub のリポジトリシークレットを Cloudflare Worker secrets に載せてデプロイします。再認証までの秒数 `AUTH_TTL_SECONDS` は秘密ではないので、`wrangler.jsonc` の `vars` にデフォルト（180日）を置き、GitHub の Actions variable で上書きできます。

リポジトリの Settings → Secrets and variables → Actions に次を追加してください。

| 名前 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers デプロイ用。ダッシュボードの「Edit Cloudflare Workers」テンプレート |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボード右サイドバーの Account ID |
| `AUTH_PASSWORD` | 認証パスワード |
| `COOKIE_ENCRYPTION_KEY` | OAuth 用署名鍵 |
| `PIYOLOG_FEED_URL` | ぴよログ Data Feed の URL |
| `CHILD_NAME` | ツール説明の呼び名 |
| `AUTH_TTL_SECONDS` | 再認証までの秒（Actions **variable**。未設定なら 15552000 = 180日） |

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set AUTH_PASSWORD
gh secret set COOKIE_ENCRYPTION_KEY
gh secret set PIYOLOG_FEED_URL
gh secret set CHILD_NAME
# 任意。未設定なら wrangler.jsonc の 180日
# gh variable set AUTH_TTL_SECONDS --body 15552000
```

未設定のまま `main` に push すると、空の値で本番シークレットを上書きしないようデプロイ前に失敗します。ローカルの `wrangler dev` はこれまでどおり `.dev.vars` を読みます。

## 開発

```bash
npm run type-check
npm run dev          # http://127.0.0.1:8787
```

`wrangler types` で `worker-configuration.d.ts` を更新できます。

## セキュリティ

詳しくは [SECURITY.md](SECURITY.md) を見てください。脆弱性は Issue に書かず、メンテナへ非公開で連絡してください。

## ライセンス

[MIT](LICENSE)
