# 资本市场首页

## 本次目标和执行计划

一次性开发与隔离发布：spaceflag.site 默认根页面显示跨资产及板块热图、公开系统性压力代理与最新正式基金经理日报；真实采集每15分钟更新，保留来源、市场时点与失败状态。原交易页在 /dashboard。参考用户指定的《系统性资金流信号》笔记，收益/趋势/波动率代理与真实申赎、CTA仓位、Gamma库存严格区分。

使用 loop-engineering 的发现、实现、验证、独立复核循环，发布按 deploy-binance-vps 的现有独立Dashboard release流程；只对新模块及入口/精确名单作小范围改动。不改受保护交易src、风险、授权、钱包或既有报告发送任务。并行按文件隔离：collector、HTML、路由/部署各自独占文件。复用现有SITE_CSS，ui-ux-pro-max设计检索只作可读性、响应式与可访问性参考，不引入前端库或CDN。

验收：采集计算/缺失/失败保留专项、HTML及动态日报读取、认证及根路由、加载器/发布保护与正式现有测试通过；生产HTTPS/登录/原页面可用；交易身份与受保护文件、Bot/Caddy PID不变。原有未提交工作保留，构建以生产当前release为基底，仅叠加本次文件。

## 进度

- [x] 读取指定455行笔记、既有页面/报告代码及发布隔离约束。
- [x] 相关现有测试34/34通过，日志 artifacts/market-landing-20261108/baseline-tests.log。
- [x] 确认生产当前页面release为20261108-remove-asset-ai，已存在11/08正式日报归档；不回滚其他任务的资产页面改动。
- [x] VPS Yahoo公开chart源SPY/QQQ/IWM/SOXX/UUP两年日线响应200且完整；Stooq返回挑战HTML，不作为后备。行情不等于资金流。
- [x] 完成17个固定标的的数据、页面及根入口，ETF复权收益与现价分离，VIX单独展示。
- [x] 计算/页面/认证/隔离联合专项54/54通过；独立检查47/47通过。正式全量回归1163项：1161通过、2项平台跳过、0失败。
- [x] 生产隔离发布与真实HTTPS/登录保护/新服务执行及15分钟timer启用验收。
- [x] 浏览器已实际渲染首页，17项、区间选择、时点、3个模型及正式日报可见。桌面截图检查完成；Mac锁屏后改用独立IAB本地预览，未绕过系统锁屏。


## 验证细节

- 原首页重定向先由回归复现302而非200；新根路由及所有浏览器落点统一为市场页，/dashboard继续返回原交易页面。
- 公共来源固定Yahoo chart v8，17项VPS原生Node首采全部OK（北京时间11/08 23:59；行情自身时点保留，休市ETF仍为纽约11/06）。本机Node网络403单独如实记录，不把curl200或其他主机可用当作本机成功；实际采集部署在VPS。
- 同步测试覆盖拆分/分红、未收盘日线、BTC UTC日界、VIX旧null、收益与最新报价日期错位、未来/重复/乱序、失败缓存与全失败保留latest。
- 独立review复现并修复：AIQ与SPY不同源日期/缓存时禁止精确相减；报价新而日线旧时PARTIAL且收益未知；安装两项新unit中途失败也会清理半安装。所有修复先有失败证据再修正。
- 日报只从生产扁平正式归档daily.md与daily.html读，排除预览/未来/不完整/损坏；不改生成、去重或飞书发送流程，不发送任何新消息。
- 热图17项按等面积网格表达收益，非资金量；16项市场代理加VIX风险温度，趋势/风险预算只作模型观察。没有真实AUM/份额历史及交易商库存，未宣称真实净申赎/Gamma。
- 数据来源核验： https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d ，Yahoo复权定义 https://in.help.yahoo.com/kb/adjusted-close-sln28256.html ，AIQ发行商 https://www.globalxetfs.com/funds/aiq 。轻量热图参考D3官方treemap说明 https://d3js.org/d3-hierarchy/treemap ，本次固定17项直接使用CSS Grid，无新增依赖。

首轮正式全量回归1162项出现1项旧导航顺序断言失败（随后并行HTML代理新增1项测试）；首页新增导航符合新需求，更新test/live-dashboard-html.test.mjs中唯一对应导航断言后，其7项通过，完整串行复验1163项全部有效通过。首轮失败及最终输出均保留。

发布前Mac锁屏使SSH agent签名失效；正常SSH使用现有指定密钥、进程级IdentityAgent=none/IdentitiesOnly=yes后已成功连接原服务器，不修改凭据、锁屏或安全设置。生产相同四文件也会逐字节核对检查基线，若并行页面任务改动则拒绝覆盖并要求重整包。

## 生产验收结果

- 新默认首页及 /market 已在独立 release `/opt/binance-agentic-personal-assets/releases/20261108-market-home` 上线；基底为 `20261108-remove-asset-ai`，70项清单检查/暂存/loader验收通过，未覆盖其他资产页面工作。新精确guard在同名工具release归档，未改工具current。
- 首采北京时间2026-11-09 00:05:08，17项全部OK。随后真正systemd service手动验收00:05:49–00:05:54成功退出0，17项全OK；CPU累计约0.987秒，CPUQuota20%、MemoryMax192MiB、TasksMax32生效。MemoryPeak当前系统不提供，不将限额当实际内存用量。
- timer enabled/active，每15分钟采集、20秒内抖动；下一轮自然触发00:15左右，当前自然周期尚未发生，不伪报自然运行成功。
- 公网认证后根首页、/market、1日/20日切换、API、正式日报原链接、/dashboard、/assets、/btc-radar、/crypto、/fund-manager、/operations全部200；新API/页面匿名401，根入口继续由原认证跳转登录。当前首页自动读到11月8日正式日报，非预览。
- 只重启Dashboard。交易全部src身份仍为f42b7f29af0826b645c4ecebd885ca0f222554d7d48dc37e5aafd9da2c5678b5；交易entry/配置/凭据/策略控制/审批/授权release字节和Bot/Caddy PID不变，原授权HALTED/STRATEGY_CONTROL_CHANGED保持原状。没有发送日报或外部消息，没有订单/签名/钱包操作。
- 生产备份及真实回执：`/var/backups/binance-agentic-stock-bot/20261108-market-home/`。本地：`artifacts/market-landing-20261108/deploy-receipt.json`、`service-receipt.json`、`publish.log`、正式/专项测试日志。未提交或push，保留所有其他未提交工作。本地预览服务已停止。
