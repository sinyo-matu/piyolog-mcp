import { escapeHtml } from "./crypto";

function htmlHeaders(formAction = "'self'"): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action ${formAction}; frame-ancestors 'none'; base-uri 'self'`,
  };
}

const LOGIN_HEADERS = htmlHeaders("'self'");
const AUTHORIZE_HEADERS = htmlHeaders(
  "'self' https://claude.ai https://claude.com https://chatgpt.com http://localhost:* http://127.0.0.1:*",
);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      background: #f4efe8;
      color: #2c241c;
      display: grid;
      place-items: center;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: 0 16px 40px rgba(74, 46, 24, 0.08);
    }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    p { margin: 0 0 20px; line-height: 1.6; color: #6a5b4e; }
    label { display: block; font-size: 0.9rem; margin-bottom: 6px; }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #e0d4c8;
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 1rem;
      margin-bottom: 16px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 12px 16px;
      background: #c45c26;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
    }
    .error { color: #a12626; margin-bottom: 12px; }
    .client { background: #f7f1ea; border-radius: 12px; padding: 12px; margin-bottom: 16px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; }
    a.button {
      display: block;
      text-align: center;
      text-decoration: none;
      border-radius: 12px;
      padding: 12px 16px;
      background: #c45c26;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export function homePage(origin: string, child = "Baby"): Response {
  const mcp = `${origin}/mcp`;
  const html = page(
    "ぴよログ MCP",
    `
    <h1>${escapeHtml(child)}のぴよログ MCP</h1>
    <p>記録の確認は Claude または ChatGPT から行います。このサイトに閲覧用の画面はありません。</p>
    <div class="client">接続先<br><code>${escapeHtml(mcp)}</code></div>
    <p>家族パスワードは、各アプリの連携画面で入力してください。</p>
  `,
  );
  return new Response(html, { headers: LOGIN_HEADERS });
}

export type ChatgptToolAd = {
  name: string;
  title?: string;
  description?: string;
  securitySchemes?: unknown;
};

export type ChatgptScanReport = {
  checkedAt: string;
  endpoint: string;
  expected: string[];
  initialize: { httpStatus: number; ok: boolean; serverName?: string; version?: string; error?: string };
  toolsList: { httpStatus: number; ok: boolean; names: string[]; tools: ChatgptToolAd[]; error?: string };
  unauthCall: { httpStatus: number; ok: boolean; isError?: boolean; leakedRecords: boolean; error?: string };
};

export function toolsCheckPage(report: ChatgptScanReport): Response {
  const missing = report.expected.filter((name) => !report.toolsList.names.includes(name));
  const extra = report.toolsList.names.filter((name) => !report.expected.includes(name));
  const listed = report.toolsList.ok && missing.length === 0;
  const gated = report.unauthCall.ok && report.unauthCall.isError === true && !report.unauthCall.leakedRecords;
  const pass = report.initialize.ok && listed && gated;
  const rows = report.expected
    .map((name) => {
      const tool = report.toolsList.tools.find((item) => item.name === name);
      const found = Boolean(tool);
      return `<tr>
        <td><code>${escapeHtml(name)}</code></td>
        <td>${found ? "公開中" : "見つからない"}</td>
        <td>${escapeHtml(tool?.title ?? "—")}</td>
        <td>${escapeHtml(JSON.stringify(tool?.securitySchemes ?? "なし"))}</td>
      </tr>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChatGPT ツール公開チェック</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      background: #f4efe8;
      color: #2c241c;
    }
    main {
      width: min(880px, calc(100vw - 32px));
      margin: 32px auto;
      background: #fff;
      border-radius: 20px;
      padding: 28px 24px 32px;
      box-shadow: 0 16px 40px rgba(74, 46, 24, 0.08);
    }
    h1 { font-size: 1.4rem; margin: 0 0 8px; }
    p { margin: 0 0 16px; line-height: 1.6; color: #6a5b4e; }
    .status {
      display: inline-block;
      border-radius: 999px;
      padding: 6px 12px;
      font-weight: 700;
      margin-bottom: 16px;
      background: ${pass ? "#e4f4e7" : "#fde8e8"};
      color: ${pass ? "#1f6b32" : "#a12626"};
    }
    table { width: 100%; border-collapse: collapse; margin: 12px 0 20px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #efe6dc; vertical-align: top; }
    th { color: #6a5b4e; font-size: 0.85rem; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
    }
    pre {
      background: #f7f1ea;
      border-radius: 12px;
      padding: 12px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .meta { font-size: 0.9rem; color: #6a5b4e; }
    a { color: #c45c26; }
  </style>
</head>
<body>
  <main>
    <h1>ChatGPT が見るツール一覧</h1>
    <p>ChatGPT の Actions Refresh と同じく、<code>Accept: application/json</code> だけで <code>/mcp</code> の <code>initialize</code> と <code>tools/list</code> を叩いた結果です。記録データは出していません。</p>
    <div class="status">${pass ? "公開できています（6件）" : "公開チェックに失敗しています"}</div>
    <p class="meta">確認時刻 ${escapeHtml(report.checkedAt)} / ${escapeHtml(report.endpoint)}</p>
    <p class="meta">initialize HTTP ${report.initialize.httpStatus}${report.initialize.serverName ? ` / ${escapeHtml(report.initialize.serverName)} ${escapeHtml(report.initialize.version ?? "")}` : ""}</p>
    <p class="meta">tools/list HTTP ${report.toolsList.httpStatus} / 検出 ${report.toolsList.names.length}件${missing.length ? ` / 不足 ${escapeHtml(missing.join(", "))}` : ""}${extra.length ? ` / 追加 ${escapeHtml(extra.join(", "))}` : ""}</p>
    <p class="meta">未ログインの tools/call は ${gated ? "認証エラーのみ（記録は返していない）" : "想定どおりではありません"}</p>
    <table>
      <thead><tr><th>ツール</th><th>状態</th><th>表示名</th><th>securitySchemes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p>生JSON: <a href="/chatgpt-tools.json">/chatgpt-tools.json</a></p>
    <p>同じ確認を手元でする場合:</p>
    <pre>${escapeHtml(`curl -sS ${report.endpoint.replace(/\/mcp$/, "")}/chatgpt-tools.json | python3 -m json.tool

curl -sS -X POST ${report.endpoint} \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`)}</pre>
    ${report.initialize.error || report.toolsList.error || report.unauthCall.error ? `<p class="meta">詳細: ${escapeHtml([report.initialize.error, report.toolsList.error, report.unauthCall.error].filter(Boolean).join(" / "))}</p>` : ""}
  </main>
</body>
</html>`;
  return new Response(html, { headers: LOGIN_HEADERS });
}

function redirectHost(redirectUri?: string): string {
  if (!redirectUri) {
    return "";
  }
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

export function authorizePage(options: {
  oauthReq: string;
  clientName: string;
  redirectUri?: string;
  error?: string;
}): Response {
  const host = redirectHost(options.redirectUri);
  const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const html = page(
    "連携の許可",
    `
    <h1>家族記録へのアクセス</h1>
    <p>Claude Desktop から開いた場合も、この画面で許可する必要があります。許可すると Claude に戻り、コネクタの連携が完了します。</p>
    <div class="client">接続元: ${escapeHtml(options.clientName)}${host ? `<br>戻り先: ${escapeHtml(host)}` : ""}${loopback ? `<br>これはパソコン上のアプリ向けです。Claude Desktop のコネクタは戻り先が claude.ai のときに更新されます。` : ""}</div>
    ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
    <form method="post" action="/authorize">
      <input type="hidden" name="oauth_req" value="${escapeHtml(options.oauthReq)}" />
      <label for="password">パスワード</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">許可する</button>
    </form>
  `,
  );
  return new Response(html, { headers: AUTHORIZE_HEADERS });
}

export function authorizeRedirectPage(redirectTo: string): Response {
  const html = page(
    "Claude に戻しています",
    `
    <h1>許可しました</h1>
    <p>Claude Desktop に戻しています。自動で戻らない場合は、下のボタンを押してください。戻ったあとにこの画面は閉じて大丈夫です。</p>
    <p><a class="button" href="${escapeHtml(redirectTo)}">Claude に戻る</a></p>
  `,
  );
  return new Response(html.replace("<head>", `<head>\n  <meta http-equiv="refresh" content="0;url=${escapeHtml(redirectTo)}" />`), {
    status: 303,
    headers: {
      ...AUTHORIZE_HEADERS,
      Location: redirectTo,
    },
  });
}
