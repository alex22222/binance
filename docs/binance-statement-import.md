# 币安官方结单预览

交易所 API 受限时，已登录的本机浏览器可以通过币安官方「账户结单 → 导出 → Data Download Center」请求完整 Account Statement PDF。该网页渠道依赖本机及会话可用，不代表服务器 API 已连接，也不代表已经验证每日自然运行。

使用现有 Node.js、Python 3 和 `pypdf`，无需新增 npm 依赖：

```sh
node scripts/parse-binance-statement.mjs \
  /private/path/official-statement.pdf \
  /private/path/binance-web-state.private.json \
  /private/path/new-preview.private.json
```

来源状态须包含已核实的 `accountUid`、`accountEmail`、`lastAcceptedAsOf` 和 `lastDocumentSha256`，文件权限须为 `0600`。输出使用新文件名并以 `0600` 创建，不覆盖旧预览；命令日志仅包含状态、页数和结单日期。加密 PDF 需先按已有安全解密流程处理，不在命令或聊天中传递密码。

默认使用已有 `python3`。服务器若未安装 `pypdf`，可在解析工具独立版本目录建立 Python 虚拟环境，并通过 `BINANCE_STATEMENT_PYTHON=/absolute/venv/bin/python` 指定解释器；无需更改交易服务或全局 Python 依赖。

工具核对账户身份、报告期间、结单日、报告生成日、封面/合并摘要/账户明细净资产、完整钱包合计，以及非零合约账户的钱包余额、浮盈、保证金权益和持仓。金额按美分精确核对；不将网页 USDT 设置当成 PDF 的 USD，不以顶部十大持仓替代完整持仓，不静默略过未识别的金融明细行。当前仅支持已实测的英文 USD 报告版式；不支持或不一致时停止，保留旧资产。

同文件返回 `skip-already-applied`，旧结单返回 `skip-older-statement`，同日期不同文件及新日期分别返回审阅状态。此工具只写私有预览，不访问网络，不修改账本、去重状态、刷新计划或凭据。报告中的六位小数份额仅是展示精度；`0.00` 碎币估值保留为舍入证据，不单独导入成零资产。

新预览仍需与当前账本及后续手工纠错核对，再沿用备份、变更前快照、版本校验保存及 HTTPS 回读流程入账。账户净资产只计一次，合约权益已含浮盈，不能重复加上抵押品、仓位名义市值或浮盈。每日生成次数、可用日期和导出配额由既有私有运行手册管理。
