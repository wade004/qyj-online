# QYJ 无技能蓝图训练

这套目录提供一个可以实际运行、保存、恢复并复现结果的离线蓝图训练起点。它与浏览器运行时共同使用
`js/game/blueprint-policy.js` 中的 `buildBlueprintInfoSetKey`、动作 key 和
`qyj-blueprint-v2` checkpoint 契约，因此训练结果不会因为另一套手牌/下注分桶而无法命中运行时。
v2 使用固定长度的四街行动摘要与合法动作 mask；旧 v1 完整历史 key 会被明确拒绝，必须重训。

## 运行

```powershell
node training/train-blueprint.mjs --iterations 1000 --table-size 2 --round 2 --seed qyj-v2
```

默认输出为 `training/checkpoints/qyj-blueprint-v2.json`。继续同一条确定性随机序列：

```powershell
node training/train-blueprint.mjs --resume training/checkpoints/qyj-blueprint-v2.json `
  --iterations 1000 --output training/checkpoints/qyj-blueprint-2000.json
```

恢复时 RNG 状态以 checkpoint 为准：显式传入不同的 `--seed` 会报错，避免制造“已经换 seed”
的假象；`--blend-weight` 只影响运行时发布权重，因此允许在恢复时显式更新且不会消耗 RNG。

无论 checkpoint 请求多高的 `blendWeight`，正式机器人运行时都会把有效权重硬限制在 `0.35` 以内；带 `visits` 的低样本信息集还会按 `visits / (visits + 50)` 继续降权。训练产物不能绕过这两层安全限制。

覆盖 2～6 人、四个回合阶段和三档筹码深度的课程训练：

```powershell
npm run train:blueprint:curriculum -- `
  --preset 6max `
  --iterations 1000 `
  --max-raises 3 `
  --seed qyj-v2-6max `
  --output training/checkpoints/qyj-v2-6max.json
```

九人课程把 `--preset` 改为 `9max`。课程分片使用独立确定性 seed，重叠信息集按真实 `visits`
加权合并；输出会分别报告 exact/history/position/strategic 的节点数与支持量。`sourceExactVisits`
是展开回退层和应用发布阈值前的精确节点访问量；`totalSupportVisits` 会重复包含层级聚合支持，不能当成
独立训练样本数。

发布阶段会生成 `exact → history-free → position-group → strategic` 四级节点，但不会把所有训练节点
塞进浏览器：默认精确节点至少 50 次访问、回退节点至少 10 次访问才发布。战略级回退仍保留自己的
手牌强度、公开牌面、存活人数、赛制阶段、合法动作 mask、加注权和全下语义，不能跨规则边界借用
策略。阈值可用 `--min-exact-visits` 和 `--min-backoff-visits` 提高。

`--max-raises` 是蓝图自身的动作抽象上限，不会修改正式 Engine 的合法动作。checkpoint 会持久化该值，
运行时只在蓝图 key/动作子集上复现同一上限，原 QYZ 基础策略仍能使用 Engine 提供的全部合法加注。
默认值从 1 提高到 3，以覆盖常见 3-bet/4-bet 路径；更深的加注树仍属于当前有损抽象边界。

只发布运行时策略、删除 regret 和 RNG 恢复状态：

```powershell
node training/train-blueprint.mjs --resume training/checkpoints/qyj-blueprint-2000.json `
  --iterations 0 --runtime-only --output assets/blueprints/qyj-blueprint-v2.json
```

只有联赛晋级门通过并核对报告中的 SHA-256 后，启动代码才应加载该静态文件：

```js
import * as AI from './js/game/ai.js';

await AI.loadBlueprintCheckpoint('/assets/blueprints/qyj-blueprint-v2.json');
```

加载或校验失败会保留此前策略；也可以调用 `AI.clearBlueprintCheckpoint()` 立即回退到纯范围/EV机器人。
当蓝图 key 命中时，运行时先按有效权重做一次干预 gate；未触发时原样保留已经抽好的 QYZ 动作，
只有触发后才从纯蓝图分布采样，因此评测不会被“二次重抽基础策略”的噪声污染。
回退层还会在访问置信度之外分别乘以 `history=0.6`、`position=0.35`、`strategic=0.15`；exact 节点为 1。
粗粒度聚合节点不会仅凭访问量较大就取得与精确节点相同的干预权重。

可用 `node training/train-blueprint.mjs --help` 查看桌型、筹码深度和加注上限参数。

## 算法

`ExternalSamplingMccfr` 是通用 external-sampling MCCFR 内核。每次迭代依次把每名玩家作为
traverser：机会事件和其他玩家的动作按当前策略抽样，traverser 的全部合法动作则被展开；正遗憾值通过
regret matching 转换为下一轮策略，平均策略按迭代数线性加权后写入运行时蓝图。

`QyjAbstractHoldemGame` 是无技能单手适配器：

- 真实 52 张牌、完整翻前至河牌和当前项目的牌型比较器；
- 2–9 个座位、盲注、弃牌/过牌/跟注/全下和项目现有 1/3、1/2、2/3 底池加注档；
- 主池、多个边池、平分底池与筹码守恒；
- 对手暗牌和未揭示公共牌不会进入信息集 key；
- 每条街的加注次数有明确上限，避免把首版训练树伪装成完整无限注博弈树。

同一个 seed、参数和迭代数会生成相同 checkpoint。checkpoint 的可选 `trainerState` 保存 RNG
状态、累计 regret、累计平均策略和访问次数，因此“先训练 N 次，再恢复 M 次”等同于一次连续训练
N+M 次。每个运行时 infoset 同时保存 `visits`，低样本节点会由运行时降低混合权重。

## 保证边界

这不是完整九人 QYJ CFR，也不能据此声称达到职业牌手水平：

- 当前效用只是一手结束后的净大盲收益，不含 12 手最终排名、升盲、生存、能量和英雄技能价值；
- 下注树使用有限动作分桶和每街加注上限；短码 under-raise all-in 遵守正式引擎的完整加注重开规则；
- 公共信息集是有损分桶。即使两人模式，算法是标准 MCCFR 估计器，求解的也只是这个抽象游戏；
- 三人以上虽然代码可运行且终端筹码效用仍是零和，但多人 regret minimisation 没有纳什收敛保证；
- 2–9 人支持首先是训练管线和数据契约能力，不代表已经有足量九人策略覆盖。

建议按“两人无技能 → 三人翻后 → 六人单手 → 12 手赛制 → 技能进入搜索树”的课程逐级训练，并让
独立评测联赛用镜像牌序、完整换座、候选/基线逻辑槽位交叉和置信区间决定 checkpoint 是否晋级。
不要仅以训练 regret 或训练时自我对局收益作为发布依据。

## 文件

- `blueprint/rng.js`：可序列化的确定性 PRNG。
- `blueprint/mccfr.js`：通用 external-sampling MCCFR、regret matching 和 checkpoint 恢复。
- `blueprint/qyj-abstract-game.js`：无技能、单手、有限下注树适配器。
- `blueprint/curriculum.js`：多人数/回合/筹码分片与访问量加权合并。
- `train-blueprint.mjs`：checkpoint 保存/恢复 CLI。
- `train-blueprint-curriculum.mjs`：v2 覆盖课程 CLI。
- `../test/blueprint-training.mjs`：隐私、筹码守恒、2–9 座状态机、确定性恢复和小型零和收敛测试。
