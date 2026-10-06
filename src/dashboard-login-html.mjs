import { SITE_CSS } from "./site-shell.mjs";

export function dashboardLoginHtml({ invalid = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>登录手机 Dashboard</title>
  <style>${SITE_CSS}
    * { box-sizing: border-box; }
    body { display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 390px); padding: 28px 26px 26px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); box-shadow: var(--shadow); }
    .login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; color: var(--muted); font-size: 14px; font-weight: 650; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { margin: 0 0 22px; color: var(--muted); line-height: 1.55; }
    label { display: block; margin-top: 14px; color: #cbd2db; font-size: 13px; }
    input { width: 100%; min-height: 48px; margin-top: 7px; padding: 10px 12px; border: 1px solid #34404e; border-radius: 10px; color: var(--text); background: var(--bg); font: inherit; font-size: 16px; }
    input:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; border-color: transparent; }
    button { width: 100%; min-height: 50px; margin-top: 22px; border: 0; border-radius: 10px; color: var(--brand-ink); background: var(--brand); font: inherit; font-size: 16px; font-weight: 760; cursor: pointer; }
    button:hover { background: var(--brand-strong); }
    button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
    .error { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; color: #ffadb4; background: var(--red-soft); }
  </style>
</head>
<body>
  <main>
    <div class="login-brand"><span class="site-mark" aria-hidden="true">A</span><span>Agentic Wallet</span></div>
    <h1>登录手机 Dashboard</h1>
    <p>使用 Dashboard 用户名和密码。登录仅在 HTTPS 加密连接中有效。</p>
    ${invalid ? '<div class="error" role="alert">用户名或密码错误</div>' : ""}
    <form method="post" action="/login">
      <label>用户名<input name="username" autocomplete="username" required></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录并打开 Dashboard</button>
    </form>
  </main>
</body>
</html>`;
}
