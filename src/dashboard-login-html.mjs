export function dashboardLoginHtml({ invalid = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>登录手机 Dashboard</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: #f5f7fa; background: radial-gradient(circle at 20% 0, #2a2415, transparent 34rem), #080a0e; }
    main { width: min(100%, 390px); padding: 26px; border: 1px solid #29313d; border-radius: 18px; background: #11151c; }
    h1 { margin: 0 0 8px; font-size: 27px; }
    p { margin: 0 0 22px; color: #9ba6b4; line-height: 1.55; }
    label { display: block; margin-top: 14px; color: #cbd2db; font-size: 13px; }
    input { width: 100%; min-height: 48px; margin-top: 7px; padding: 10px 12px; border: 1px solid #34404e; border-radius: 10px; color: #f5f7fa; background: #080a0e; font-size: 16px; }
    button { width: 100%; min-height: 50px; margin-top: 20px; border: 0; border-radius: 10px; color: #171108; background: #f5c14f; font-size: 16px; font-weight: 760; }
    .error { margin: 0 0 12px; color: #ff8d96; }
  </style>
</head>
<body>
  <main>
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
