# Polymarket 永续资产只读同步

在现有 Polymarket 公开地址连接中启用 `includePerps`。同一账户、每天原定时间读取预测市场与永续账户；Future 不启用此范围。设置 → 只读同步 → Polymarket 可调整读取范围，先预览再入账。

使用官方公开 GET 接口，无代理密钥、签名或交易请求：

- `https://api.perpetuals.polymarket.com/v1/info/registered?address=...`
- `/v1/info/instruments`
- `/v1/info/portfolio?address=...`

资料：[官方账户说明](https://docs.polymarket.com/perps/account-management)、[保证金与净权益](https://docs.polymarket.com/perps/learn-about-trading/margin)、[OpenAPI](https://docs.polymarket.com/api-spec/perps-openapi.json)。

统计：预测现金与全部预测仓位使用已核实的 USDC/USD 报价；永续部分直接使用官方返回的 USD `equity`，新增单条「永续合约」净权益明细。平台参考总额不重复计入。净权益已含未实现盈亏、应计费用和资金费，不另加转入本金、保证金、名义敞口或浮动盈亏。即使平仓后没有持仓，账户留存净权益仍计入。

`unrealized_pnl` 按全部合约汇总为带符号的 USD 参考盈亏，存入原有盈亏列表并标记 `scope: perpetuals`、官方毫秒时间转换的 `observedAt` 和真实 `fetchedAt`。页面区分永续与预测收益，不将此字段再次加减资产。杠杆、强平价与保证金模式不在公开 Portfolio 响应中，不能根据转入金额、仓位或 ROE 反推；用户提供的 5× 不是 API 当前核验值。

读取校验注册、完整仓位、唯一合约身份、官方 perpetual/pUSD 产品元数据、带符号十进制字段及两分钟来源时点。预测读取前后分别读永续快照，持仓身份/数量/均价与「净权益减未实现盈亏」须稳定，避免跨账户转账期间重复计入；允许标记价格使净权益和盈亏同步变化。只接受非负净权益，负净权益需要负债账本支持，本轮保留旧数据。

任何部分失败均不部分写入。完整通过后沿用现有预览、账本版本校验、变更前快照、正常保存及回读流程。首次人工验收不代表首个每日自然周期成功。自动周期同时保护资产与盈亏指纹，后续手工纠错会暂停覆盖。
