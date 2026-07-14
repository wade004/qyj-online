# QYJ 机器人强度评测联赛

这套工具用于回答一个具体问题：机器人修改后究竟变强了，还是只在少数牌例里看起来更聪明。

它直接运行正式 `Engine`，支持 6/9 人桌、原生最多 12 手赛程、固定种子、循环座位、桌序镜像、策略池、动作统计、按独立种子聚类的 bootstrap 置信区间，以及可以接入 CI 的晋级门。

## 快速运行

```powershell
npm run eval:ai -- --quick --seed local-smoke
```

标准六人中性扑克评测：

```powershell
npm run eval:ai -- --seeds 20 --seed qyz-candidate-v1 --json reports/qyz-candidate-v1.json
```

九人桌：

```powershell
npm run eval:ai -- --table 9 --seeds 20 --seed qyz-9max-v1 --json reports/qyz-9max-v1.json
```

`--seeds` 表示独立牌序簇。每个牌序簇内部会进行座位轮换和桌序镜像；这些变体不能被当成互相独立的统计样本，因此置信区间先在同一牌序簇内求平均，再对牌序簇做 cluster bootstrap。

自动晋级还要求完整循环换座（`--rotations full`，或数值等于桌型人数）并保留镜像。`--quick`、减少轮换或 `--no-mirror` 的报告只用于诊断，晋级门固定返回 `unbalanced-seat-schedule`，避免座位和相邻对手顺序被误判成策略提升。

多人桌中，整桌轮换仍会保留候选与基线在逻辑座位环中的相对位置。正式晋级因此会自动追加一套“候选 ↔ 基线逻辑槽位互换”的同种子赛程，其他对手的槽位保持不变；最终先在每个种子内合并原槽位和互换槽位，再做配对统计。候选和基线必须在阵容中各出现一次，否则返回 `candidate-baseline-crossover-required`。

默认设置 `Engine.rules.skillsEnabled=false`，同时关闭主动与被动英雄效果，得到中性扑克基准。评测整套 QYJ 英雄系统时显式添加 `--skills`：

```powershell
npm run eval:ai -- --skills --seeds 20 --seed qyj-skills-v1
```

技能和部分规则会按行动路径消耗随机数，因此技能评测仍然可由种子完全复现，但不同座位变体在后续手牌中不保证拥有逐张完全相同的牌序。报告中的 `sharedInitialSeedAcrossSeatVariants` 只表示变体从相同初始随机流开始。

技能模式目前只用于诊断“策略 + 固定英雄”组合。由于逻辑选手在座位轮换时仍携带同一个英雄，英雄强度会与策略强度耦合；因此只要开启 `--skills`，晋级门就会强制返回 `skills-enabled-requires-hero-crossover`，即使统计下界为正也不会发布。正式策略晋级必须使用默认无技能模式；技能版本将在加入“策略 × 英雄交叉轮换”后再开放自动晋级。

## 策略池

查看内置策略：

```powershell
npm run eval:ai -- --list-strategies
```

当前包含生产 QYZ 范围/EV 策略的 TAG、紧手、激进、松手和诈唬风格，以及跟注站、过牌弃牌和合法随机基线。自定义阵容使用逗号分隔；不足桌型人数时循环填充：

```powershell
npm run eval:ai -- --lineup qyz,qyz-tight,calling-station --seeds 20
```

### 训练 checkpoint 候选

`--blueprint` 会读取并一次性编译当前 `qyj-blueprint-v2` checkpoint，只把它绑定到名为 `blueprint` 的逻辑候选；同桌 `qyz` 基线会显式关闭蓝图，因此不会受到全局运行时 checkpoint 污染：

```powershell
node training/train-blueprint.mjs `
  --iterations 10000 `
  --table-size 6 `
  --seed candidate-v1 `
  --output training/checkpoints/candidate-v1.json

npm run eval:ai -- `
  --blueprint training/checkpoints/candidate-v1.json `
  --table 6 `
  --seeds 30 `
  --gate-metric rank `
  --require-promotion `
  --json reports/candidate-v1.json
```

生产候选优先使用覆盖课程，而不是只训练一个固定六人/第一回合分片：

```powershell
npm run train:blueprint:curriculum -- `
  --preset 6max `
  --iterations 1000 `
  --output training/checkpoints/candidate-v2.json
```

没有显式 `--lineup` 时，CLI 自动组成 `blueprint`、`qyz` 和其他基线的阵容，并把晋级比较改为 `blueprint vs qyz`。显式阵容必须包含 `blueprint`。

蓝图报告会区分“文件被加载”“节点被命中”和“策略真正发生变化”：

- `blueprintHitRate`：全部候选决策中找到一个**可用层级**的比例；它可能来自 exact，也可能来自 history、position 或 strategic 回退，不能解释为“精确 key 命中率”；
- `exactHitRate`：只有完整 public infoset key 直接可用时才计数的精确命中率；
- `blueprintBackoffCounts` / `blueprintBackoffRates`：分别记录 `exact`、`history`、`position`、`strategic`、`unknown` 和 `none` 的次数/占全部候选决策比例；
- `blueprintConditionalWeight`：只在命中决策上计算的平均有效权重；
- `interventionRate`：蓝图对合法动作分布产生非零干预的决策比例；
- `actionChangeRate`：加入蓝图后最终选择动作发生改变的比例；
- `meanPolicyTV`：全部候选决策上基础 QYZ 分布与纯蓝图分布的平均 total variation distance（未命中为 0），它描述策略分歧，不是实际混合位移；
- `meanInfluence`：`effectiveWeight × policyTV` 在全部候选决策上的平均值，表示实际期望分布位移；
- `meanBlueprintNodeVisits`、`meanBlueprintConfidence`：命中节点的平均训练访问量和置信度。

旧 checkpoint/runtime 缺少某个诊断字段时，该字段按 0 处理，绝不会因为兼容回退而误过晋级门。

回退查找顺序为 `exact → history → position → strategic`：history 忽略细粒度动作历史，position 再合并位置，strategic 进一步合并牌力、牌面和筹码分桶。层级越靠后，覆盖率通常越高，但针对当前精确局面的证据越弱。`unknown` 表示旧遥测报告“可用”却没有层级信息，`none` 表示没有可用节点。CLI 中 `bp usable/exact` 分别显示可用命中率和精确命中率，`E/H/P/S #` 显示层级次数，`H/P/S rate` 显示三种回退占全部决策的比例；完整 JSON 保留所有层级 count/rate。

蓝图晋级默认同时要求：**可用层级命中率**至少 1%、平均影响至少 1%、动作改变率至少 1%。为保持已有发布门兼容，目前没有单独的 exact 最低门；exact 和各回退层作为必须审阅的归因遥测。对应失败原因分别是 `blueprint-hit-rate-below-threshold`、`blueprint-influence-below-threshold` 和 `blueprint-action-change-rate-below-threshold`。CLI 可以把三个门槛调高；参数必须位于 0～1，设置为 0 只适合诊断，不建议用于发布。

升级 v2 前的真实诊断使用六人桌、1000 轮旧抽象训练，再运行 8 个独立种子、完整换座、镜像和候选/基线逻辑槽位交叉，共 192 局。3206 次候选决策只有 119 次找到当时可用的策略节点；可用层级命中率 3.71%，全部决策平均有效权重仅 0.000707，候选与 QYZ 的排名和 HP 优势都精确为 0。这个旧指标不能回答其中多少是 exact 命中；该旧产物已失败且 v2 运行时会明确拒绝它。这些数据用于解释为什么必须压缩历史、提高节点访问量并增加影响量门，而不是作为当前候选成绩。

CLI 还会把 checkpoint 原始文件的 SHA-256 写入 JSON 报告。发布流程必须核对该摘要，确保最终部署的正是经过联赛评测的文件，而不是同路径下后来被替换的产物。

逻辑选手的策略和英雄会一起移动到不同物理座位。基础完整轮转加镜像在六人桌每个种子产生 12 局、九人桌产生 18 局；开启默认晋级门后，候选/基线交叉换槽使其分别增至 24 局和 36 局。`--no-gate` 不追加交叉赛程；`--rotations 3` 或 `--no-mirror` 可用于快速诊断，但没有晋级资格。

原生比赛通常进行 12 手；若只剩一名存活玩家，Engine 会按正式终局规则提前结束。JSON 中同时记录 `rounds`、`fullSchedule` 和 `naturalEarlyFinish`，不会把合法提前终局伪装为完整赛程。

## 报告指标

每个策略输出：

- 平均最终排名和第一名率；
- 存活率、最终 HP、HP 变化、平均存活手数；
- 弃牌、过牌、跟注、加注、全下、主动攻击、主动技能和被动触发次数；
- 以上核心结果按独立牌序簇计算的 bootstrap 置信区间；
- 每一局、每一个逻辑选手的机器可读明细。

快速模式或只有一个独立种子时，置信区间会退化成单点并打印警告。这类结果只能检查程序是否正常，不能用于判断机器人强弱。

## 晋级门

默认比较 `qyz` 候选与 `qyz-tight` 基线。排名优势定义为：

```text
baseline 平均排名 - candidate 平均排名
```

HP 优势定义为：

```text
candidate 平均 HP - baseline 平均 HP
```

所以两个指标都是正数代表候选更好。只有完成候选/基线逻辑槽位交叉，且配对 bootstrap 置信区间下界严格大于阈值、独立种子数不少于默认的 8，才能晋级：

```powershell
npm run eval:ai -- `
  --seeds 30 `
  --candidate qyz `
  --baseline qyz-tight `
  --gate-metric both `
  --require-promotion `
  --json reports/promotion.json
```

`--require-promotion` 在失败时返回退出码 2，可直接用于 CI。可用参数：

- `--gate-metric rank|hp|both`；
- `--min-paired-seeds 8`；
- `--min-improvement 0`；
- `--min-blueprint-hit-rate 0.01`（仅蓝图候选）；
- `--min-blueprint-mean-influence 0.01`（仅蓝图候选）；
- `--min-blueprint-action-change-rate 0.01`（仅蓝图候选）；
- `--confidence 0.95`；
- `--bootstrap 2000`。

例如把蓝图的实质影响门整体提高到 2%：

```powershell
npm run eval:ai -- `
  --blueprint training/checkpoints/candidate-v2.json `
  --seeds 30 `
  --min-blueprint-hit-rate 0.02 `
  --min-blueprint-mean-influence 0.02 `
  --min-blueprint-action-change-rate 0.02 `
  --require-promotion
```

长期发布门建议至少使用 20～30 个独立牌序簇，并把 `rank` 作为首要指标；HP 是辅助诊断，因为 QYJ 的正式目标是 12 手后的最终名次。

## Opt-in exact infoset 训练画像

需要找出真实对局中最常到达、但 exact 覆盖不足的公共子局时，可显式生成独立训练画像：

```powershell
npm run eval:ai -- `
  --blueprint training/checkpoints/candidate-v2.json `
  --seeds 20 `
  --exact-infoset-profile training/profiles/candidate-v2-reach.json `
  --profile-strategies blueprint,qyz `
  --profile-top 50000 `
  --profile-max-raises 3 `
  --json reports/candidate-v2-league.json
```

参数说明：

- `--exact-infoset-profile` 是唯一启用开关；未指定时没有额外 Observation/key 构造成本；
- `--profile-strategies` 选择采集策略，缺省为有 checkpoint 时的 `blueprint`，否则为 `qyz`；
- `--profile-top` 只保留最高频的 N 个 exact key，完整唯一 key 数和 `truncated` 标记仍会写入；
- `--profile-max-raises` 必须为 0～3，默认 3，并写入画像契约以匹配训练 key 编码。

画像使用独立的 `qyj-exact-infoset-reach-profile-v1` 契约，条目按 `count` 降序、exact key 字典序作为次排序，不含墙钟字段，因此同一输入可确定性复现。CLI 将画像写到独立文件，并只向终端输出路径、安全计数和 SHA-256。

每个 key 保存频次、来源策略、实际动作、usable/exact/backoff 遥测，以及一个确定性代表的 training-only snapshot。snapshot 严格只允许：

- `observerIdx`、round/street/dealer、盲注、已揭示 board、hand/active seats；
- 每个公开玩家的 idx、HP、fold/all-in、街/手下注、acted 和 position；
- 只由历史公开行动聚合的 hands/VPIP/PFR/3Bet/AF/Fold-to-CBet 范围先验；
- 观察者自己的 `selfHole`；
- 当前 betting、legalActions；
- 重建公共历史所需的公开 action 字段，包括行动时 board 前缀和行动前筹码/街投入。

严禁写入 deck、未揭示 future board、任何对手暗牌、playerId/name、hero、knowledge 或 Engine/Observation 引用。同一个 exact key 只保留 JSON 字典序最小的代表 snapshot，避免输入遍历顺序影响产物。

由于 snapshot 含观察者的物理暗牌，画像属于敏感训练产物：它绝不会嵌入普通联赛 report、match errors 或控制台 key 输出。普通 JSON 即使同时开启画像也仍不含 `bp2|...` raw key和暗牌。画像与普通 `--json` 路径必须不同。

画像目前强制 `skillsEnabled=false`，避免私有技能知识无法由允许字段完整重建。它表达当前策略下的真实 reach frequency，可用于优先训练高频 exact miss、history/position/strategic 回退热点和公共子局；实际动作只用于诊断，不应被当作 GTO 标签直接模仿。

## Profile-conditioned 公共子局训练

画像可以直接驱动精确公共根训练：

```powershell
npm run train:blueprint:targeted -- `
  --profile training/profiles/qyz-reach.json `
  --top 1000 `
  --visits 100 `
  --blend-weight 0.35 `
  --belief-temperature 0.5 `
  --seed qyz-targeted-v2 `
  --output training/checkpoints/qyz-targeted-v2.json
```

训练器会硬校验 profile 的 exact key 与重建根完全相同，并为每个目标保证恰好 `visits` 次 traverser 根更新。每个非英雄座位（包括已弃牌者）先根据位置、公开行动和收缩后的公开统计构造 1326 组合后验；所有对手暗牌按后验权重乘积、条件于物理牌互斥联合抽样，再从剔除英雄牌、当前 board 和全部对手牌后的牌堆均匀抽取未来 runout。`belief-temperature` 把启发式行动似然向 uniform 收缩，0 表示忽略行动证据，1 表示完整似然。运行时产物只保存模型版本、温度、根策略和统计，不保存 posterior、代表 snapshot、对手暗牌、未来牌或训练下游节点。2～9 人、稀疏物理座位、短码大盲全下、未跟注退款和边池均走与 Engine 对齐的状态机。

在投入完整训练前，应先用模拟器真实暗牌做离线聚合校准；真实牌只在内存中评分，报告不保存 seat、card、range vector 或 raw key：

```powershell
npm run eval:ai -- `
  --seeds 8 --rotations full --mirror --no-gate `
  --calibrate-beliefs --belief-temperature 0.5 `
  --json reports/belief-calibration.json
```

`beliefCalibration.conditioned` 分别报告 posterior/uniform 的 log-loss、Brier 及改善量。两个改善量都严格大于零才标记 `passed=true`；技能对局会拒绝校准，避免忽略技能私有知识后给出虚假结论。

每个合法动作同时保存 Welford 统计 `{samples, mean, m2}`。运行时把纯 blueprint 分布与当前 QYZ 分布的经验优势写成动作价值线性组合，并使用保守 95% 下界：缺动作、样本少于阈值、下界不大于零时，权重严格归零且不消耗干预 RNG。普通报告只聚合 `advantageCompleteRate`、`advantagePassRate`、`meanAdvantage`、`meanAdvantageLowerBound`、样本量和动作覆盖率，不包含 raw key 或牌。

需要从多个独立 exact 根构造有支持下限的分层发布节点时：

```powershell
npm run publish:blueprint:backoff -- `
  --input training/checkpoints/qyz-targeted-v2.json `
  --output training/checkpoints/qyz-targeted-v2-backoff.json `
  --min-exact-visits 100 `
  --min-backoff-visits 200
```

发布器用并行 Welford 公式合并动作价值，并把 exact/history/position/strategic 支持量分别写入 coverage。回退节点仍受正优势下界和 `history=0.6 / position=0.35 / strategic=0.15` 权重折减；聚合支持高不等于自动有资格接管。

## JSON 与自检

将完整报告写入文件：

```powershell
npm run eval:ai -- --json reports/latest.json
```

只向标准输出写 JSON，方便管道消费：

```powershell
npm run --silent eval:ai -- --quick --json-only
```

`--silent` 用于隐藏 npm 自己的脚本标题；直接执行 `node scripts/run-ai-league.mjs --quick --json-only` 也只会输出 JSON。

运行联赛基础设施自检：

```powershell
npm run test:eval
```

自检覆盖固定种子复现、6/9 人完整赛程、生产 QYZ 策略接入、合法动作保护、座位轮换/镜像、按种子聚类的置信区间，以及命中率/策略影响/动作变化三重蓝图晋级门。

## 2026-07-12 v2 覆盖课程实验

最终语义一致的六人实验课程按 2–6 人、四个赛程阶段、8/20/80BB 三档筹码各训练 1000 次；为控制本轮计算量显式使用 `--max-raises 1`，生产训练默认应使用 3。发布前 exact 源节点共得到 1,763,491 次 traverser 访问；应用 `exact>=50`、`backoff>=10` 的阈值后，发布 81,558 个信息集：history 19,173、position 21,816、strategic 40,569、exact 0。层级支持量会重复包含同一源访问，不能解释成独立训练样本。文件大小为 24,932,797 字节，SHA-256 为 `4970F488BC514E62997C481D46112D56E51A2899A627BEAAF3C3C8E83208A06F`。

正式评测使用 8 个独立种子、六人全换座、镜像及候选/基线逻辑槽位互换，共 192 局。usable hit 为 52.96%，但 exact hit 为 0；其中 strategic 回退率为 52.83%，history/position 各仅 0.07%。命中后的平均有效权重为 1.82%，全体决策平均影响为 0.63%，干预率 0.90%，动作改变率 0.64%。这证明 checkpoint 在运行，但覆盖主要来自最粗回退，尚未形成可发布的精确信息集策略。

相对原 QYZ 的平均排名优势为 +0.0156，95% 配对置信区间为 [-0.0313, 0.0781]；HP 优势为 +23.85，95% 区间为 [-35.52, 107.99]，强度与基线不可区分。晋级同时被 `blueprint-influence-below-threshold` 和 `blueprint-action-change-rate-below-threshold` 阻断，统计门也没有清除零点。因此该 checkpoint 只保留为实验产物，不得复制到静态资源或设为默认机器人策略。下一轮应提高 exact 节点访问覆盖，而不是重新放大 strategic 回退权重。

## 2026-07-12 profile-conditioned 实验

从 4 个独立训练种子、六人全换座与镜像的 48 局中采集 840 次 QYZ 决策，得到 775 个唯一 exact 根；全部目标各训练 100 次真实根访问，共 11,186,313 次效用采样。exact-only 候选在 8 个全新种子、192 局晋级赛中命中 40/3146（1.27%），动作统计 40/40 完整，2 次通过优势下界、1 次实际改变动作；最终 HP 优势仅 +0.42，95% 区间 [0, 1.25]，排名无变化。

随后仅发布支持量至少 200 的回退节点，得到 775 exact、6 history、6 position、55 strategic。新一轮独立 192 局中覆盖 239/3143（7.60%），优势统计 239/239 完整，7 次通过、2 次改变动作；排名优势 +0.0104，区间 [0, 0.0208]，HP 优势 +5.0，区间 [-2.5, 17.5]。全体决策平均影响仅 0.000214，动作改变率约 0.064%，仍同时被统计门、影响门和动作变化门阻断。因此 exact 与 backoff 两个候选均未部署，线上继续使用原 QYZ。

## 2026-07-12 public-belief v3 实验

温度扫描在独立的 6,411 个行动条件样本上比较 0～0.8；0.1～0.8 均优于 uniform，最终选择兼顾 log-loss 与 Brier 的 0.5。正式训练画像的 48 局、13,700 个条件样本上，log-loss 改善 +0.05515，Brier 改善 +0.00011；另一组 held-out 24 局、9,516 个条件样本仍分别改善 +0.07143 和 +0.00011。

新版画像产生 756 个 exact 根，每根 100 次真实访问，共 10,818,216 次效用采样；分层发布得到 756 exact、7 history、10 position、73 strategic。独立 8 种子、192 局晋级赛覆盖 223/3220（6.93%），其中 6 次通过动作优势下界，但安全干预实际触发 0 次，最终行为、排名和 HP 与 QYZ 完全相同。平均影响 0.000084、动作改变率 0，仍被影响门和动作变化门阻断。结论是公共信念校准和物理采样问题已经修复，但当前单手 chip-EV 子局仍不足以形成可部署提升；该模型未复制到静态资源。
