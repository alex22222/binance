# 八 ETF 服务器只读采样运行说明

## 范围与时间

本次任务已在服务器独立运行调度，不依赖 Mac 或模型服务。目标为八只固定 ETF（SPY、QQQ、IWM、EFA、EEM、TLT、GLD、DBC）×三个固定金额（50、217.66、250 USDT）×九个窗口，共216对常规时段双向报价。此前9对offhours不计入。

| 纽约交易日 | 北京时间开盘后15分钟 | 常规时段中点 | 收盘前30分钟 |
|---|---|---|---|
| 2026-11-16 | 11-16 22:45 | 11-17 01:45 | 11-17 04:30 |
| 2026-11-17 | 11-17 22:45 | 11-18 01:45 | 11-18 04:30 |
| 2026-11-18 | 11-18 22:45 | 11-19 01:45 | 11-19 04:30 |

对应UTC同一纽约交易日14:45、17:45、20:30；最终报告定于2026-11-18 20:55UTC，即北京11-19 04:55。错过采样不补跑；服务器恢复后可以只补做报告。

## 代码与已部署版本

- `scripts/research-turtle-rfq.mjs`：官方合约身份、市场状态和精确数量双向报价，只读命令白名单。
- `scripts/research-turtle-rfq-server.mjs`：使用正在运行Bot的最小钱包环境和binancebot UID/GID；服务器原生模式选择local=true，不使用Mac的SSH环境。
- `scripts/research-turtle-rfq-chain.mjs`：已有交易hash的公共BSC回执核对。
- `scripts/scheduled-turtle-rfq.mjs`：固定九窗口、资格门槛、哈希、去重和进度汇总。旧Mac启动路径不再调度。
- `scripts/server-turtle-rfq.mjs`：服务器原生入口、内核锁、报告生成，以及`nativeTimerUnits()`提供的八个systemd单元定义。
- 测试：`test/turtle-rfq-research.test.mjs`、`test/scheduled-turtle-rfq.test.mjs`、`test/server-turtle-rfq.test.mjs`。

服务器隔离代码目录为`/opt/binance-turtle-rfq-20261116/release-v3`，状态目录为`/var/lib/binance-turtle-rfq-20261116`。不能用仓库整体同步覆盖交易应用。v1、v2保留历史，实际服务全部指向v3。

v3 manifest SHA256为`0a825f6da0b72c4452cb592796bcd8fd427143124b2a140c7e346c8588bfd022`。发布目录中的`release.json`声明SERVER_NATIVE、固定state/report路径、scheduleHash、五个基础sources、一个nativeSources、报告基线hash和八个unitHashes。基线文件为`baseline.md`，SHA256为`c7a254a23d5c5414a42358187d82da33f2e5759ce78f35995a2a3387e4f68677`。它是部署当时研究报告的快照，不随未来文档编辑重写。

单元名称固定为`binance-turtle-rfq-20261116-{open,mid,close,final}.{service,timer}`。采样三个timer使用绝对2026日期且Persistent=false；final单独Persistent=true，成功后仅禁用本次四个timer。原Mac的etf-15、etf、etf-30三条任务均已暂停，不能恢复并行采样。

源码提交不等于重新部署。当前部署已完成，本次提交不重装单元、不重启服务、不改变实盘配置。运行快照、原始回执、冻结副本、日志与钱包资料不进Git；本次也不包含其他长历史研究引擎或其他策略研究的未提交改动。长历史结果背景见`docs/2026-11-15-turtle-eight-etf-research.md`，采样本身不重新运行那210组回测。

## 只读边界

首次钱包调用必须在固定时间后10分钟内，后续调用和合格结果限制在20分钟内；精确买入输出原样反向报价，往返两次响应不超过30秒。仅常规市场、身份、数量、公式、源hash、进程成功标记和生产保护均通过的样本计数。

采样CLI只允许status/settings/quote；费用证据另限wallet address和指定已有hash的tx-history（BSC56，最多20笔历史hash）。公开地址只留hash。禁止登录、签名、下单、send/swap/approve、修改钱包、策略、风控或审批。操作指引保留1.12.0，CLI1.10.0，不为研究升级工具。

所有原生阶段共用内核flock，进程退出释放；每槽claim永久保留，没有报价报告的失败或中断不重采。采集进程在 20 分钟报价窗口之外再留 4 分钟做痕迹扫描、费用读取、指纹和 JSON 输出；flock 与 systemd 比采集更长，以便父进程落盘报告和收据。进程在最终 JSON 已经输出后被计时器杀掉时，这份完整报告仍可计合格报价；真正的非零退出仍然不计。若进程在 `quote-report.json` 已落盘、`receipt.json` 尚未写完时被杀掉，下次进入该槽或最终汇总只根据已保存报告补写收据，不再调用钱包；只有 claim、没有报告的窗口仍计为未采集。非零退出的完整JSON诊断仍留档，但不计合格样本。不得删claim、绕锁、伪造时钟或降低216门槛。交易应用顶层src、配置、审批/策略控制文件不写入；不启动Paper，不重启Bot/Dashboard。

## 结果和核验

每槽文件位于状态目录的`slots/<日期-phase>/`，包括脱敏报价、claim、receipt及历史Gas证据。`progress.json`记录覆盖和缺口，不能把只有claim或状态标签当作有效报价。

final仅读取已有证据，不调用钱包或模型。结果写入状态目录`report.md`、`final-result.json`，并更新交易应用`docs/2026-11-15-turtle-eight-etf-research.md`。若目标报告被其他作者修改，保留冲突而不覆盖，隔离报告仍保存。本地副本要在下次连接后同步。

网络Gas、Bot旧美元换算、服务方networkFee、用户最终额外扣费和报价内含是不同事实。字段为0不等于免费。未知保持UNKNOWN；216对齐全也只表示覆盖完成，automaticTradingEligible始终false，独立人工复核保持PENDING，不由程序自签PASS。原210组历史回测和不切换实盘的结论保留。

只读查看（服务器）：

```sh
systemctl list-timers --all 'binance-turtle-rfq-20261116-*'
systemctl show binance-turtle-rfq-20261116-open.service --property=ExecStart,Result
```

进度入口会原子更新研究进度文件，但不获取报价：

```sh
node /opt/binance-turtle-rfq-20261116/release-v3/scripts/server-turtle-rfq.mjs --status
```

不要为了核验手工启动采样服务、运行裸CLI或提前触发final。

离线测试：

```sh
node --test test/server-turtle-rfq.test.mjs test/scheduled-turtle-rfq.test.mjs test/turtle-rfq-research.test.mjs
```

部署核验时22项通过；窗口外真实systemd执行返回OUTSIDE_WINDOW_NO_WALLET_CALL；内核锁竞争返回75，持锁进程退出后恢复。四timer均enabled/active/waiting，Bot PID2980283与Dashboard PID2980130、受保护配置/控制/源码聚合hash均未变。设置完成不是未来采样或报告完成的证明。

## 磁盘容量快照

2026-11-16北京时间00:08只读核验：根分区总容量约22.88GiB，可用6.79GiB（7.29GB），使用率约69%，inode仅用4%。本次采样代码三个历史版本合计约0.29MiB，研究状态约0.04MiB。已有9对offhours原始报告约0.46MiB；按完整24对、来源和Gas记录预留整批100MB，属保守容量预算而非实际占用或硬上限，足够承接本轮三个交易日。

主要现存占用为应用state约2.16GiB、历史备份约1.96GiB、系统journal约1.37GiB；其中action-trace.jsonl约521MiB。采样流式读取日志，不为每个窗口复制整份日志。总磁盘仍会受其他服务日志增长影响，不能从单次快照推断长期还能用多少天。本次未清理或修改任何服务器文件。
