# 盈立香港结单预览

盈立香港的邮件 PDF 渠道已经用真实附件验证；它依赖邮箱会话和结单送达，不代表券商 Open API 已获批，也不能保证每天都有新结单。当前工具仅支持已验证的香港 `uSmart Securities Limited` / SFC `BJA907` 中文日结单、月结单版式。新加坡结单和非空期权、沽空、碎股表暂不支持，遇到这些情况停止并保留旧资产。

先按现有安全流程解密，保留原邮件附件及解密回执。不在聊天、命令参数或日志中传密码，也不向该工具提供 API 密钥。

```sh
node scripts/parse-usmart-statement.mjs \
  /private/path/unlocked-statement.pdf \
  /private/path/source-binding.private.json \
  /private/path/new-preview.private.json
```

来源绑定文件权限须为 `0600`，包含以下字段：

- `provider`: `usmart-hk`。
- `accountId`: 先前已经核实的券商账户号码，不以待解析 PDF 自行建立身份绑定。
- `retainedAsOf`: 当前账本中相关现金和持仓已确认日期的保护界限；还须单独检查更晚的手工纠错，不能用行情日期代替数量确认日。
- `reviewedDocuments`: 已实际审阅的原附件列表，每项包含 `documentSha256` 和真实结单日期 `asOf`。未审阅的附件不能预先加入此列表。
- `originalPdfPath`: 下载的原始 PDF，绝对路径或相对于绑定文件的路径。
- `originalDocumentSha256`、`parsedDocumentSha256`: 原始附件、安全解密副本的 SHA256，从下载和获授权的解密回执绑定；不能把解密后的哈希当作邮件附件哈希。

工具同时校验两份文件的哈希。仅读取已经解密的 PDF，不尝试密码；默认使用已有 `python3` 和 `pypdf`，可通过 `USMART_STATEMENT_PYTHON=/absolute/venv/bin/python` 指定已有独立解释器。不使用 `pypdf` 的 layout 提取模式，因为已验证文件的法律实体页眉会在该模式下丢失。

解析内容包括：连续页码和末页、法律实体、账户、市场币种列、结单日期与印单时间、分币种期初/期末净资产、证券市值、有符号现金、待交收金额、负债和抵押金额，以及全部已支持的普通证券持仓。印单时间未注明时区，按原文保留，`printTimeZone` 为 `null`，不擅自标为北京时间。持有数量与已交收数量分别保留，不能用后者覆盖前者。所有持仓行都须识别并与币种汇总、封面核对；抵押金额可有四位小数，封面按分舍入核对。未开通币种保留为未开通，不制造零余额。

净资产按各币种的证券市值加现金计算。负现金、待交收金额和已显示负债均保留为证据，不能再次重复扣减；抵押市值也不是额外资产。预览对负现金或负债增加 `signed-cash-or-debt` 审阅原因，不能直接写入只接受非负资产金额的现有账本，更不能为迁就导入而丢掉负数或擅自更换账户统计口径。

同一已审阅原附件返回 `skip-already-reviewed`，早于保护日期返回 `skip-older-statement`，同日期不同文件和新日期分别返回 `review-same-date-changed-document`、`review-newer-statement`。重印日、邮件收到日和解析日都不改变资产日期。即使日期较新，也须核对近期手工纠错、完整现金与持仓、账户映射，才能沿用原有预览、快照、版本校验保存和 HTTPS 回读流程入账。

输出以 `0600` 新建，不覆盖已有文件。日志仅包含决定、页数、结单日期及零财务写入计数。工具没有网络请求，也不更新账本、来源去重状态、凭据、刷新时间或估值绑定；成功解析不等于最新余额已同步。
