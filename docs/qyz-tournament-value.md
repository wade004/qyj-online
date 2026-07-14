# QYZ 公共锦标赛价值 V3

## 本轮结论

本轮把 targeted MCCFR 的叶值从“只能看当前一手 chip EV”扩展为可选的 12 手公共续局价值。正式价值模型已经通过 6/9 人桌质量门，但由它训练出的 blueprint 候选没有通过独立联赛的作用率门，因此没有替换线上机器人策略。

正式数据包含每桌 720 个独立 seedGroup，按桌型分别拆分为 504/108/108 个 train/validation/test 组，共 21,600 场、252,150 条公开状态。正式模型在 untouched test 上相对“按当前筹码直接排序”的朴素基线：

| 桌型 | 模型 RMSE | 基线 RMSE | 相对改善 | 95% cluster CI（绝对 RMSE 改善） | OOD 覆盖 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 0.49703 | 0.61225 | 18.82% | [0.10317, 0.12681] | 99.78% |
| 9 人 | 0.40670 | 0.48818 | 16.69% | [0.07180, 0.09054] | 99.92% |

平滑有界输出的硬裁剪率为 0；170,020 次同一玩家筹码转移压力测试的单调性违反为 0；联合玩家价值投影后的最大定和误差为 `1.33e-15`。正式质量报告的 `promotion.passed=true`。

## 数据契约与隐私

采集器只在真实 `Engine` 的公共手牌边界记录：

- 初始桌型、已完成手数、下一手大盲；
- 焦点玩家筹码、排序后的其他玩家筹码；
- 从下一手按钮位开始的存活筹码环；
- 焦点在该筹码环中的相对位置。

它不写入暗牌、牌堆、board、行动历史、英雄、账号、绝对座位、单样本策略或可重放 Engine 的原始 seed。`seedGroup`、`matchId` 和 `sampleId` 都由至少 32 字节秘密生成 HMAC opaque ID；秘密与原始 seed 不进入 dataset。拆分先按 6/9 桌分层，再以整个 seedGroup 为不可分割单位。

默认只把 `qyz` 座位作为预测目标；其他策略只构成续局对手分布。默认采集完整换座和镜像，避免把固定策略与固定物理座位混淆。

## 模型

`training/tournament-value/model.js` 实现无第三方依赖的确定性 bootstrap ridge ensemble：

- 支持严格的 2～9 人输入契约；生产 Engine 数据覆盖初始 6/9 桌；
- 使用公开筹码分布、存活人数、赛程、BTN/SB/BB 角色和按钮相对筹码环；
- bootstrap 单位是整个 seedGroup，不把同一场的席位/边界当作独立证据；
- residual uncertainty 使用 cluster out-of-bag 误差，并用独立 validation RMSE 只向上校准；
- 未训练桌型或 `(tableSize, round, aliveCount)` 组合强制标记 OOD；
- 使用 `tanh` 目标链接，输出天然位于 `[-1, 1]`；
- 注入固定的单调筹码份额先验，降低求解器利用局部非单调误差的风险；
- artifact 只保存特征 schema、标准化器、OOD 包络和模型参数，不保存源行或 group ID；
- canonical JSON 保证相同模型语义产生相同字节与 SHA-256。

目标值为：

```text
1 - 2 * (finalRank - 1) / (tableSize - 1)
```

第一名为 `+1`，最后一名为 `-1`，完整名次集合严格零和。

## targeted MCCFR 接入

`training/tournament-value/targeted-leaf.js` 将抽象单手终局映射为下一手公共状态。焦点本手出局、第 12 手或只剩一名存活者时，直接按现行 Engine 名次规则精确结算，不调用模型。

`training/tournament-value/targeted-utility.js` 提供四层安全约束：

1. 同一 checkpoint 的所有 exact key、公开变体和存活玩家必须全部通过根 OOD、不确定性和局部单调性探针；任一失败则整份 checkpoint 使用原 BB chip EV。
2. 域内继续叶使用模型价值；域外继续叶使用“已投影根价值 + 正比例筹码份额变化”的同量纲替代，不把 BB 值与 `[-1,1]` 名次值直接混合。
3. 同一叶面对所有存活玩家联合预测，并投影到该存活人数应有的精确名次价值总和。
4. 运行时再次做局部筹码转移单调探针，违反或探针 OOD 时转入同量纲筹码替代。

抽象摊牌结算也已与真实 Engine 对齐：每层底池整数均分，余筹按按钮后的顺时针顺序发放，稀疏 9 人物理座位环保持不变。

## 命令

采集公开数据：

```powershell
npm run collect:tournament-value -- `
  --tables 6,9 `
  --seeds 720 `
  --workers 16 `
  --rotations full `
  --mirror `
  --output training/datasets/qyz-tv-v3.json
```

训练和正式门控：

```powershell
npm run train:tournament-value -- `
  --dataset training/datasets/qyz-tv-v3.json `
  --output training/checkpoints/qyz-tv-v3.json `
  --report training/checkpoints/qyz-tv-v3-quality.json `
  --require-pass
```

只有 quality report 正式通过且 SHA 匹配时，targeted CLI 才接受模型：

```powershell
npm run train:blueprint:targeted -- `
  --profile training/profiles/qyz-reach-6.json `
  --profile training/profiles/qyz-reach-9.json `
  --tournament-value-model training/checkpoints/qyz-tv-v3.json `
  --tournament-value-report training/checkpoints/qyz-tv-v3-quality.json `
  --visits 100 `
  --output training/checkpoints/qyz-targeted-tv-v3.json
```

## 正式发布门

每个部署桌型必须同时满足：

- train/validation/test 独立 seedGroup 至少 500/100/100；
- test RMSE 相对筹码排名基线改善至少 5%；
- 配对 seedGroup bootstrap 的 95% RMSE 改善下界大于 0；
- OOD 接受覆盖至少 95%；
- 硬裁剪率小于 0.1%；
- 局部筹码单调性违反为 0；
- 联合价值投影定和误差不大于 `1e-9`。

`--pilot` 永远添加 `pilot-mode` 阻断，不能产生可晋级报告。

## 本轮正式产物与候选结论

- Dataset SHA-256：`3031AB6EF5FC11CBFCB3F41563AB34E0B0062034D69AEBFB7783A04C34AFD3A8`
- Model SHA-256：`065757FCBFC6D4F1C2EA4E1BD85624666C889CC99FB12B1344FA0F46DB5EC4FC`
- Quality report SHA-256：`D320470B4984733A0A7B8485246FB6CDC63FABBF78F17B5B7201DA489E32C15F`
- 6/9 联合 exact checkpoint SHA-256：`7B3F195DE6B72F2BD66599869E50C9997CE779F86860FAD0A8BC4FDFD517B9ED`
- 保守 backoff candidate SHA-256：`FB1F2C1341B33918ADF4B3060377C7FDBDCF7EB01990C5397EA8FB6EC93425DD`

联合训练覆盖 157 个至少被 reach 两次观测的 exact key、296 个公开变体，每根 100 次 traverser 更新；1,811/1,811 个模型根预检通过，原始 chip-EV 回退为 0。发布器保留 157 个 exact 节点，并仅发布 11 个达到 200 访问支持下限的 strategic 节点。

候选随后分别使用 30 个全新独立 seed cluster 完成正式联赛：6 人 720 场、9 人 1,080 场。两份报告记录了相同 candidate SHA，但都没有晋级：

| 桌型 | usable hit | exact hit | mean influence | action change | 结论 |
|---|---:|---:|---:|---:|---|
| 6 人 | 1.371% | 0.279% | 0 | 0 | influence / action-change 门失败 |
| 9 人 | 1.279% | 0.327% | 0.00176% | 0.00595% | influence / action-change 门失败 |

6 人候选因优势下界全部未通过而与 QYZ 行为完全相同；9 人只有 5/215 次命中通过优势门，配对排名优势为 `-0.00185`，95% CI 为 `[-0.00556, 0]`。这些产物没有复制到静态资源，也没有替换当前线上机器人策略。

## 仍需继续的工作

- 把公开 HUD 的原始分子/分母计数做成可更新的充分统计，加入续局状态；当前 VPIP/PFR/AF 比例不足以精确更新 counterfactual 手牌后的画像。
- 冻结候选策略后，用独立 seed clusters 和生产一致的 continuation 单独校准 exact 节点动作优势，绑定 policy SHA、评估器版本和独立 cluster 数；不再把训练内 action moments 解释为严格的 95% 证据。
- 提高 held-out reach 覆盖。当前约 1.3% usable hit 使 1% 动作改变门在数学上不可达；需要更密集的公共策略泛化，而不是简单放宽门或只增加同一根访问次数。
- backoff 优势证据必须按独立来源 root/seed cluster 聚类；不能把相关 rollout 数量当作独立样本量。
- 将技能、能量和英雄状态正式加入全赛程价值；当前价值模型严格是 `skillsEnabled=false`。
- 长期目标仍是完整公共信念价值网络与在线 subgame solving；本轮 ridge ensemble 是安全、可解释的 V3 基线，不代表世界顶级职业牌手水平。

## V4 覆盖率与紧凑残差策略（影子阶段）

上一轮候选失败的主要原因不是叶值模型精度，而是实际对局中的策略命中率过低。本轮因此没有继续放宽动作优势门槛，而是补齐以下基础设施：

- `frozen-calibration.mjs` 对冻结策略的 exact root 强制枚举所有合法动作，以独立 seed cluster 和共同随机数计算 paired contrast；产物绑定策略、锦标赛模型、质量报告、评估器、基础策略 contract 与 style 的 SHA/版本。
- reach profile 升级到 `qyj-exact-infoset-reach-profile-v2@2`，原始 seed group 改为 HMAC opaque ID，并要求训练与留出 profile 的 SHA、source group 完全不交叉且 secret fingerprint 一致。旧 V1 profile 可读取，但不可晋级。
- 新增 shadow-only `population` backoff 与独立 held-out coverage gate。它的运行时影响乘数固定为 0，不能改变实时动作。
- 新增 `qyj-compact-residual-policy-v1` 浏览器运行时。模型只能在 QYZ 基础分布的 log 概率上添加有界、按 legal mask 分头的分类残差；零概率动作保持零概率，未知类别、支持不足、基础策略契约不匹配或 ensemble 不确定性过高时拒绝。
- 残差 schema 只接受 `mode=shadow-only`；影子评估始终返回原来的基础策略对象，不采样动作、不消耗动作 RNG。未来可部署版本必须使用新 schema，并重新通过独立冻结策略评估。

正式 V2 discovery 使用同一个 HMAC secret fingerprint，6/9 人桌各 64 个训练 source group；留出覆盖各 16 个全新 group，训练与留出交集为 0。当前 population shadow 候选的独立覆盖结果为：

| 桌型 | 命中决策 / 留出决策 | population coverage | 25% 门槛 |
|---|---:|---:|---|
| 6 人 | 67 / 2,769 | 2.4196% | 失败 |
| 9 人 | 43 / 4,503 | 0.9549% | 失败 |

因此 V4 候选没有进入正式联赛，也没有替换线上机器人。紧凑残差模型目前同样只完成严格运行时契约，尚未训练：V2 profile 只记录已选动作，缺少每个公共决策处完整的 QYZ 基础动作概率分布。下一步必须采集按 source group 隔离的 V3 概率数据，再训练残差 ensemble、校准 OOD/不确定性，并先通过 6/9 人桌 25% held-out coverage 与独立冻结策略优势门槛。

## V5 全动作概率采集与残差蒸馏（诊断候选）

本轮补通了 V3 概率数据、训练和全决策影子评估链路：

- 联赛在不改变动作的情况下记录完整 QYZ 基础动作分布以及冻结 blueprint 的目标分布；确定性 fallback 显式记录为 one-hot 分布。
- 数据行以单个 HMAC source group 和 exact root 为原子单位，允许同一 root 在不同独立组重复出现；训练、验证和测试只能按完整 source group 切分。
- source-group HMAC 输入域加入桌型，避免相同 seed 名称在 6/9 人桌产生相同 opaque ID。
- 目标带 `exact/history/position/strategic/population` 层级标签，训练权重依次降低，粗粒度 backoff 不能冒充 exact 监督。
- 残差运行时升级为 `qyj-compact-residual-policy-v2`。`legal-support-floor-log-v2` 使用契约中显式绑定的 `epsilon=0.0001`，仅在影子分布中给所有合法动作建立可学习支持；线上 QYZ 分布不变。
- 五成员 bootstrap ensemble 使用 6/9 人桌共 10 个训练来源组，并按桌型分别做 group-disjoint 60/20/20 切分。模型仍被 schema 锁定为 `shadow-only`。

诊断采集结果：6 人桌 2,580 个决策中得到 60 次目标决策、10 个 group/root 行；9 人桌 5,490 个决策中得到 72 次目标决策、8 个 group/root 行。联合数据共 18 行。监督行的留出评估覆盖为 100%，mean target TV 为 `0.00244`，但这只衡量有目标的稀疏行。

使用完全不同的基础 seed 做全决策影子评估：

| 桌型 | 独立诊断组 | accepted / decisions | 全决策覆盖 | mean shadow TV | 假想动作变化 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 2 | 270 / 894 | 30.20% | 0.000602 | 0 |
| 9 人 | 2 | 693 / 2,322 | 29.84% | 0.000615 | 0 |

诊断覆盖首次超过 25%，但不能晋级：每桌只有 2 个新组，未达到正式样本规模；大量决策仍因未训练 legal mask 或 OOD 拒绝；候选对基础策略的改变量极小且没有产生假想动作变化；尚未完成绑定该 residual continuation 的独立动作优势校准。因此没有进入正式联赛，没有替换线上策略，也不能据此宣称达到顶级职业牌手水平。

## V6 legal-mask 语义投影蒸馏

V5 联合训练数据只出现 `4d = fold/call/feint/all-in` 一个动作头，而独立 6/9 人桌对局出现 `5/42/45/4a/4d/5a/5d/7a/7d` 九种常见 mask。V6 在不跨 source group 的前提下进行低可信度语义投影：

- fold/call 在无下注场景合并到 check；
- aggressive mass 在目标 mask 可用的 raise tiers 间按递减先验分配；
- all-in 只在合法时保留，否则投影到最激进的合法动作；
- 基础分布和目标分布一起投影，避免只改目标造成虚假残差；
- 所有派生行标记为 `mask-projected`，训练权重为 exact 的 12%；
- 派生行继承原始 source group，train/validation/test 隔离不变；
- 正式晋级新增 `mask-projected-targets-require-calibration` blocker。

训练行由 18 个真实 group/root 行扩展为 162 个带层级行，形成 9 个 legal-mask heads。新模型在投影 test 行上的 mean target TV 为 `0.00154`。使用另一套全新基础 seed 的全决策影子结果：

| 桌型 | accepted / decisions | 覆盖 | unsupported mask | OOD | mean shadow TV | 假想动作变化 |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 288 / 1,056 | 27.27% | 0 | 744 | 0.000645 | 0 |
| 9 人 | 936 / 2,331 | 40.15% | 0 | 1,377 | 0.000657 | 0 |

legal-mask 缺口已被消除，新的首要瓶颈是分类特征 OOD 和残差影响过小。由于评估仍只有每桌 2 个独立组、策略没有产生假想动作变化、投影目标没有独立动作优势校准，V6 继续保持 shadow-only，没有进入正式联赛或线上部署。

## V7 层次化类别回退

V6 的 OOD 主要来自位置、手牌桶、筹码深度、轮次、SPR 和行动上下文在训练组中的支持不足。V7 没有直接放宽 OOD 阈值，而是升级到 `qyj-compact-residual-policy-v3`：

- 每个 legal-mask head、每个特征都有按训练 source group 汇总的 `__GLOBAL__` 参数和支持计数；
- 精确类别达到 `minCategoryGroups` 时使用精确参数；
- 精确类别不足但全局参数有独立组支持时，回退到零均值全局参数；
- 每次层次回退计为 0.5 个 OOD 单位，真正没有可靠全局支持仍计为 1 个；
- 模型输出显式记录 `fallbackFeatures` 和 `fallbackFeatureCount`；联赛报告记录每个 accepted 决策的平均回退特征数；
- 新增 `hierarchical-category-fallback-requires-calibration` 晋级 blocker。

第四套全新基础 seed 的诊断结果：

| 桌型 | accepted / decisions | 覆盖 | OOD | mean fallback features | mean shadow TV | 假想动作变化 |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 816 / 948 | 86.08% | 132 | 4.74 | 0.000873 | 0 |
| 9 人 | 1,485 / 2,169 | 68.46% | 666 | 4.72 | 0.001178 | 0 |

V7 同时加入新观察到的 `6a` legal mask，使本次 6/9 评估的 unsupported-mask 拒绝为 0。覆盖率提升明显，但 accepted 决策平均仍使用约 4.7 个全局回退，且没有产生假想动作变化。这说明下一瓶颈已经不是覆盖率，而是缺少足够强且经独立验证的动作优势信号。因此 V7 仍然只作为诊断影子模型，不部署。

## V8 独立动作优势指导

V8 将冻结 continuation 强制动作评估接入残差训练：

- 新 CLI 从 reached exact profile 构造真实 `QyjTargetedHoldemGame` root；
- 每个独立 seed cluster 对所有合法动作使用共同随机数，随后冻结为同一个 exact→backoff continuation；
- 校准产物绑定 frozen policy SHA、正式锦标赛价值模型/报告 SHA、基础策略 contract/style 和 20 个 HMAC cluster ID；
- 优势指导以 QYZ 基础混合策略为对照，对每个动作计算 paired contrast、均值和单侧小样本 t-LCB；
- 只有 LCB 大于零的动作能够通过有界 logit shift 改写残差目标；全部 LCB 非正时目标必须保持 QYZ 基础分布；
- 训练 manifest 同时绑定数据集和 advantage-guidance 内容；证据覆盖不足时新增 `independent-action-advantage-coverage-below-threshold` blocker。

当前真实采集只提供一个可校准的 6 人 exact root，9 人为 0。该 root 使用 20 个新 cluster、每 cluster 4 个共同随机数 rollout：

| 动作 | 平均名次价值 | 相对 QYZ fold 的均值优势 | 95% 单侧 LCB |
|---|---:|---:|---:|
| fold | 0.19275 | 0 | 0 |
| call | -0.11052 | -0.30327 | -0.45946 |
| raise:feint | -0.03062 | -0.22337 | -0.36680 |
| all-in | -0.26905 | -0.46179 | -0.60921 |

因此 `calibratedRoots=1`、`actionableRoots=0`、`actionableActions=0`。V8 正确撤回了该 root 上没有收益证据的蓝图偏移，没有为了制造动作变化而选择负收益动作。

第五套全新基础 seed 的全决策影子结果：

| 桌型 | accepted / decisions | 覆盖 | mean shadow TV | mean fallback features | 假想动作变化 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 666 / 948 | 70.25% | 0.00251 | 4.84 | 0 |
| 9 人 | 1,800 / 2,178 | 82.64% | 0.00370 | 4.49 | 0 |

V8 的关键提升是建立“只有正的独立收益下界才能改变策略”的闭环，而不是当前候选已经变强。由于只校准了一个 6 人 root、9 人没有校准 root，候选仍不可晋级或部署。

## V9 分层反事实 root 扩展

V9 不再要求自然对局命中已发布 exact checkpoint。它从真实公共 reach profile 中按 `(street, legal-mask)` 分层选择 root，并使用纯离线 `qyj-counterfactual-root-action-calibration-v1` 评估：

- 反事实 schema 复用冻结 continuation evaluator，但浏览器 checkpoint 编译器不接受它，不能附着到线上策略；
- 每个 root 单独 preflight 和校准，失败只记录 root SHA 与安全原因，不影响其他 root；
- 新增全决策 QYZ 基础分布采集器，即使没有 blueprint 命中也保存完整概率向量；
- 6 人采集 150 个 group/root 行、918 个决策，9 人采集 250 行、2,259 个有效决策；
- 只选择同时拥有完整 QYZ 基础分布和训练 snapshot 的 roots，避免用抽样动作次数冒充策略概率；
- 6/9 人桌各选择 16 个分层 roots，每 root 使用 12 个独立 cluster、每 cluster 2 个共同随机数 rollout；
- 优势指导物化为 33 行、32 个唯一校准 roots，并保留原始 profile source group；随后与旧训练数据合并。

反事实结果：

| 桌型 | calibrated roots | actionable roots | actionable actions |
|---|---:|---:|---:|
| 6 人 | 16 | 9 | 9 |
| 9 人 | 16 | 10 | 11 |

第七套全新基础 seed 的影子结果：

| 桌型 | accepted / decisions | 覆盖 | mean shadow TV | mean fallback features | argmax 变化 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 1,146 / 1,158 | 98.96% | 0.00529 | 2.49 | 0 |
| 9 人 | 2,511 / 2,556 | 98.24% | 0.00446 | 2.71 | 0 |

V9 首次在 6/9 人桌都获得多 root 的正 LCB 动作，且影子概率分布开始产生约 0.5% TV 的移动。不过 argmax 尚未变化，校准规模只有 12×2，留出评估每桌只有 2 个 source group，尚未运行真正采用 residual continuation 的正式配对联赛。因此仍然不部署。

## V10 离线 residual 因果配对联赛

V10 新增只存在于 `training/eval/strategies.mjs` 的 `residual-candidate`：

- 每次决策先运行冻结 QYZ，得到基础动作与完整概率分布；
- 使用绑定 SHA 的 residual 模型计算候选分布；
- 只在离线策略注册表中使用独立策略 RNG 采样候选动作；
- 浏览器运行时和全局 AI 配置没有 residual 激活入口，模型 schema 仍是 `shadow-only`；
- 联赛记录 residual decisions、accepted、实际采样动作变化、TV 和 fallback 数；
- 晋级同时要求配对收益 LCB、覆盖率、mean TV、实际动作变化率、完整轮换、镜像以及候选/基线槽位交叉。

使用全新 `qyj-residual-paired-v9` seed namespace、完整物理座位轮换、镜像和 candidate/baseline 逻辑槽位互换的诊断结果：

| 桌型 | 对局 | 独立 seeds | coverage | 动作变化 | mean TV | 名次优势 | 95% 诊断 CI | HP 优势 | 95% 诊断 CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 48 | 2 | 99.20% | 29/754（3.85%） | 0.00508 | +0.27083 | [+0.16667,+0.37500] | +138.60 | [+10.83,+266.38] |
| 9 人 | 72 | 2 | 98.77% | 24/977（2.46%） | 0.00347 | +0.04167 | [0,+0.08333] | +25.69 | [+3.47,+47.92] |

6 人桌的诊断收益方向和物质性均为正；9 人桌 HP 为正，但名次优势下界仍等于 0。两桌都只有 2 个独立 seed clusters，正式门至少需要 8，因此 `promotion.passed=false`，原因是 `insufficient-paired-seeds`。这些结果首次证明 residual 实际采样路径能够改变动作并在小样本中改善表现，但仍不足以部署。

## V11 八 seed 正式规模复验

V11 首先加入不可绕过的硬门：当 residual 模型 schema 为 `shadow-only` 时，即使统计联赛通过，也必须添加 `residual-shadow-only-schema-cannot-deploy` blocker。随后使用全新 `qyj-residual-formal-v10` namespace，将独立 seed clusters 从 2 增加到 8；保持完整轮换、镜像、候选/基线槽位交叉和 5,000 次 cluster bootstrap 不变。

| 桌型 | 对局 | 独立 seeds | coverage | 动作变化 | mean TV | 名次优势 | 95% CI | HP 优势 | 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 192 | 8 | 98.85% | 61/3,125（1.95%） | 0.00498 | -0.02083 | [-0.19271,+0.11458] | -9.22 | [-206.07,+167.29] |
| 9 人 | 288 | 8 | 98.88% | 68/4,108（1.66%） | 0.00410 | -0.02778 | [-0.09722,+0.05208] | +39.06 | [-29.36,+106.56] |

两桌的 residual 物质性门都通过，但名次收益均值略为负且置信区间跨 0；HP 同样没有正的下界。此前 2-seed 的正向结果没有在 8-seed 复验中重现，`statisticalReason=confidence-bound-not-cleared`。因此 V8/V9 residual 候选被正式否决，不生成部署 schema，不替换 QYZ。

下一轮不应继续放大同一 residual，而应训练独立的干预选择器：根据校准 root 邻近度、LCB 强度、ensemble 不确定性和层次回退数量，只在证据强的少数节点应用残差；其余决策严格返回 QYZ。

## V12 稀疏干预选择器

V12 构建独立 `qyj-residual-intervention-selector-v1`，绑定 residual 模型 SHA 和优势指导 SHA。它只存在于离线联赛路径；决策必须同时满足：

- 与正 LCB 校准 root 使用相同 legal mask；
- 分类特征相似度达到阈值；
- fallback feature 数不超过上限；
- residual policy TV 达到最低物质性；
- 校准 root 最大动作 LCB 达到阈值。

第一版使用 similarity≥0.625、LCB≥0.01、fallback≤3、TV≥0.001，只允许 6 人桌 2/824 次决策，没有动作变化，过于保守。第二版预先调整为 similarity≥0.5、LCB≥0.005、fallback≤4、TV≥0.001，并使用全新 `qyj-selector-diagnostic-v12` namespace：

| 桌型 | accepted / decisions | 稀疏覆盖 | 实际动作变化 | eligible mean TV | 名次/HP 差异 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 5 / 765 | 0.65% | 1（0.13%） | 0.05154 | 0 / 0 |
| 9 人 | 7 / 1,041 | 0.67% | 0 | 0.01097 | 0 / 0 |

选择器消除了广泛 residual 的负向风险，但干预过少，9 人桌没有实际动作变化，两桌收益与 QYZ 完全相同。因此没有进入 8-seed 正式复验。继续放宽选择器会重新接近已在 V11 正式失败的广泛 residual，当前证据不支持这样调参。

## V13 扩展反事实优势校准

V13 不再继续放宽 V12 的稀疏选择阈值，而是扩大独立优势证据后完全重训 residual：6 人桌和 9 人桌各选择 32 个分层决策根；每个动作使用 24 个独立种子簇，每簇 8 次共同随机数 rollout，共 192 次反事实评估。两种桌型全部 32 个根完成校准且无失败。

| 桌型 | calibrated roots | actionable roots | actionable actions | LCB≥0.01 selector roots |
|---|---:|---:|---:|---:|
| 6 人 | 32 | 25 | 42 | 17 |
| 9 人 | 32 | 28 | 48 | 15 |

新优势标签与原始 QYZ 模仿数据合并为 83 个训练行，并训练 7 成员 ensemble。模型仍为 `qyj-compact-residual-policy-v3` / `shadow-only`；选择器仍为离线专用，默认门限为 similarity≥0.625、advantage LCB≥0.01、fallback≤3、policy TV≥0.001。

使用全新 `qyj-expanded-selector-v13` namespace、完整座位轮换、镜像及 candidate/baseline 槽位交叉的 2-seed 诊断结果：

| 桌型 | 对局 | accepted / decisions | 实际动作变化 | eligible mean TV | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 48 | 31 / 781（3.97%） | 4（0.51%） | 0.02108 | +0.02083 | -3.54 |
| 9 人 | 72 | 9 / 1,066（0.84%） | 2（0.19%） | 0.01473 | 0 | -0.56 |

扩样显著提高了可行动优势标签和 6 人桌干预覆盖，但两种桌型的收益方向仍不一致：6 人桌只有极小排名改善且 HP 为负，9 人桌排名持平且 HP 为负。因此按预先设定的顺序门，没有启动 8-seed 正式联赛，也没有生成部署 schema 或替换 QYZ。下一步应增加真正独立的 reach/source groups，并按桌型分别学习干预价值或训练一个显式的 accept/reject value head；继续只扩大 rollout 数量已经不能解决状态覆盖偏差。

## V14 独立 reach 来源与 intervention value head

V14 使用全新 HMAC namespace，从混合对手联赛重新采集完整轮换和镜像状态。6 人桌得到 8 个独立 source groups、1,598 个基础策略根；9 人桌得到 8 个独立 source groups、2,051 个基础策略根。训练不复用 V13 的两组 reach 数据。

每桌选择 128 个分层根，继续使用 24 个独立 cluster、每 cluster 8 次 rollout。6 人桌 128/128 根校准成功，得到 91 个 actionable roots 和 153 个 actionable actions；9 人桌 126/128 根成功，得到 93 个 actionable roots 和 145 个 actionable actions，另外 2 根因 tournament continuation preflight 不可重建而安全跳过。

训练数据物化增加 `includeIdentityRows`：被校准的根使用优势目标，未覆盖根的目标严格等于基础 QYZ。合并后共有 3,649 行、16 个 source groups，并训练 9 成员 residual ensemble。这避免模型只学习人工选择过的优势根。

`qyj-residual-intervention-value-selector-v2` 按 6/9 人桌生成独立工件，保留正负校准根。运行时在相同 legal mask 内取 5 个最近邻，至少要求 4 个邻居，并以相似度和独立 cluster 数加权预测价值；预测下界包含 1.64 倍不确定性惩罚。门限为 predicted value LCB≥0.005、fallback≤3、policy TV≥0.0001。留一校准根验证为：

| 桌型 | roots | scored | selected | positive precision | mean actual selected LCB |
|---|---:|---:|---:|---:|---:|
| 6 人 | 128 | 115 | 47 | 87.23% | 0.10015 |
| 9 人 | 126 | 102 | 56 | 85.71% | 0.07176 |

全新 `qyj-v14-value-gate-final-*` namespace 的完整轮换、镜像和 candidate/baseline 交叉诊断结果：

| 桌型 | 对局 | accepted / decisions | 实际动作变化 | mean TV | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 48 | 172 / 832（20.67%） | 17（2.04%） | 0.02216 | -0.08333 | +89.06 |
| 9 人 | 72 | 382 / 1,106（34.54%） | 10（0.90%） | 0.00681 | -0.02778 | -27.57 |

V14 value head 解决了 V12/V13 干预过少的问题，并提供 `residualRejectionReasons` 遥测；同时修复了桌型隔离最初错误使用 1 基座位数组长度的问题。但局部反事实 action value 仍未可靠转化为整场锦标赛收益：6 人桌 HP 改善而名次下降，9 人桌两项均下降。因此没有启动 8-seed 正式复验，没有生成部署 schema，也没有替换 QYZ。后续模型需要直接学习 continuation-level policy improvement，而不是仅用单决策 action advantage 近邻值作为干预标签。

## V15 value-policy bound option head

V14 的 value gate 与执行分布存在结构性错配：门控使用校准 action value，但真正采样的动作来自独立训练的 residual ensemble。V15 新增 `qyj-residual-intervention-option-selector-v3`，把价值和策略绑定在同一个校准工件中：

- 每个根同时保存 conservative calibrated value 和 `targetStrategy - baseStrategy` 动作概率增量；
- 运行时在同 legal mask 内选择 5 个近邻，以相似度和独立 cluster 数加权；
- 先计算预测 value LCB，再将同一组近邻的概率增量应用到当前 QYZ 基础分布；
- 重新投影为合法概率分布，TV 门测量最终将执行的 option 分布；
- 6/9 人桌继续使用独立工件，V1/V2 selector 保持兼容；
- option 仅存在于离线 `residual-candidate` 路径，浏览器和在线 AI 没有激活入口。

2-seed 完整轮换、镜像及 candidate/baseline 槽位交叉诊断首次在两桌同向为正：

| 桌型 | accepted coverage | 实际动作变化 | mean option TV | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|
| 6 人 | 10.4% | 0.12% | 0.0177 | +0.02083 | +16.5 |
| 9 人 | 8.5% | 0.19% | 0.0258 | +0.04167 | +19.7 |

因此按预设顺序门，使用冻结参数和全新 `qyj-v15-bound-option-formal-*` namespace 进入 8-seed 正式复验。正式结果：

| 桌型 | 对局 | seeds | coverage | 动作变化 | mean TV | 名次优势 | 95% CI | HP 优势 | 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 192 | 8 | 11.11% | 12/3,186（0.38%） | 0.01609 | -0.03646 | [-0.08333,0] | -20.10 | [-55.10,+10.39] |
| 9 人 | 288 | 8 | 8.87% | 46/4,127（1.11%） | 0.03249 | -0.21875 | [-0.53472,+0.01042] | -128.23 | [-321.11,+20.24] |

两桌物质性门均通过，但配对排名均值和 HP 均值均为负，`statisticalReason=confidence-bound-not-cleared`。这说明 V15 确实改变了策略，却在更广泛种子上降低表现；2-seed 的正向结果没有复现。V15 被正式否决，不生成部署 schema、不替换 QYZ，也不根据正式测试集继续调参。下一阶段必须校准多步 continuation option（同一玩家在后续若干决策中的联合策略），并用独立训练/验证/正式来源分别选择 option horizon，不能继续把单节点动作增量当作 continuation 策略。

## V16 有限 horizon continuation option

V16 新增 `qyj-residual-continuation-option-selector-v4` 和离线状态机。首次决策仍要求 predicted value LCB≥0.005；通过后，仅在同一 Engine、同一玩家和同一 round 内保存有限 continuation 状态。后续决策要求重新通过合法 mask、邻居、fallback、option TV 以及 continuation value LCB≥0；换手、horizon 到期或任一门失败都会立即清除状态。状态使用 Engine 弱引用隔离，不跨对局、镜像或 candidate/baseline 槽位交叉。

联赛遥测增加 `residualOptionStarts`、`residualOptionContinuations` 和 `residualOptionAborts`。独立 2-seed 验证同时比较冻结的 horizon 2/3：

| horizon | 桌型 | starts | continuations | aborts | coverage | 动作变化 | 名次优势 | HP 优势 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 2 | 6 人 | 45 | 18 | 14 | 7.88% | 0.38% | +0.06250 | +22.60 |
| 2 | 9 人 | 70 | 9 | 9 | 7.80% | 0.20% | +0.05556 | +4.03 |
| 3 | 6 人 | 51 | 31 | 28 | 10.70% | 0.26% | 0 | +9.69 |
| 3 | 9 人 | 67 | 16 | 13 | 7.75% | 0.28% | 0 | -4.44 |

H2 是唯一在两桌排名和 HP 都为正的候选，因此冻结 H2 并使用全新 `qyj-v16-h2-formal-*` namespace 运行 8-seed、完整轮换、镜像、槽位交叉和 5,000 次 cluster bootstrap 正式复验：

| 桌型 | 对局 | starts | continuations | aborts | coverage | 动作变化 | 名次优势 | 95% CI | HP 优势 | 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 192 | 248 | 95 | 70 | 11.05% | 26/3,103（0.84%） | -0.01563 | [-0.06771,+0.02604] | -31.33 | [-111.90,+29.19] |
| 9 人 | 288 | 320 | 44 | 44 | 8.46% | 15/4,303（0.35%） | -0.02431 | [-0.14583,+0.06944] | -27.71 | [-78.28,+6.11] |

正式复验中存在足够的真实 continuation 和动作变化，但两桌排名与 HP 均值仍为负，置信区间跨 0，`statisticalReason=confidence-bound-not-cleared`。因此 V16 H2/H3 均被否决，不生成部署 schema、不替换 QYZ，也不使用正式结果重新选择 horizon。结论是：仅把单节点校准策略延续到后续状态并不等价于训练多步 option。下一阶段需要在校准器中直接联合强制一段策略序列，并以整段 option 相对于 QYZ continuation 的配对收益作为标签。

## V17 联合 continuation option 校准

V17 新增 `qyj-joint-continuation-option-calibration-v1`。对每个精确根，在相同 deal seed 和 continuation seed 下成对运行两条完整 continuation：baseline 路径始终使用冻结 checkpoint；option 路径只允许同一 target actor 在同一手牌内按冻结 V16 H2 selector 控制最多两次决策，其他玩家和 horizon 之外的决策仍使用冻结 continuation。每个 cluster 先聚合内部 rollout，再以独立 cluster 作为唯一统计单位计算配对收益下界。

联合工件绑定 option selector SHA、冻结策略 SHA、锦标赛价值模型和质量报告 SHA。原始 seed 只存在于瞬态构建输入，输出仅保留独立 HMAC `jc_*` cluster ID。重复构建实现字节级相同，且工件中不存在原始 seed namespace。

第一阶段从每桌 64 个按 reach、街道和 legal mask 分层的 selector 根进行 16 clusters × 4 rollouts pilot：

| 桌型 | roots | controlled decisions | horizon reached | controlled roots | positive mean roots | positive LCB roots |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 64 | 1,339 | 123 | 19 | 2 | 0 |
| 9 人 | 64 | 1,147 | 123 | 16 | 8 | 0 |

随后只依据 pilot 中是否真实发生控制筛选可达根，不依据收益正负选择；使用全新、与 pilot 禁止重叠的 48 clusters × 8 rollouts 独立确认：

| 桌型 | reachable roots | controlled decisions | horizon reached | positive LCB roots |
|---|---:|---:|---:|---:|
| 6 人 | 19 | 7,971 | 675 | 1 |
| 9 人 | 16 | 6,759 | 615 | 9 |

V17 再新增 `qyj-residual-joint-continuation-option-selector-v5`，只保留确认阶段 LCB>0 的根，并强制 similarity=1、neighbors=1、minNeighbors=1，禁止把联合证据泛化到未校准近邻。全新 2-seed 完整轮换诊断中，两桌接受数、option starts、continuations 和动作变化全部为 0；6 人桌 776/792 次、9 人桌 1,097/1,109 次决策因 exact 联合根未命中而拒绝。

因此 V17 未达到最低 0.5% 覆盖和动作物质性门，没有进入 8-seed 正式联赛，也没有部署。放宽 exact 限制会重新允许未经联合 rollout 证明的状态，违背 V17 的证据设计。结论是联合校准器已经可用，但当前 16 维精确根抽象过细；下一阶段应为联合 option 单独设计可泛化、可交叉验证的低维状态表示，而不是复用完整 infoset 相等关系。

## V18 source-group 验证的低维联合表示

V18 新增 `qyj-residual-generalized-joint-option-selector-v6`。与 V17 只保留正根不同，V18 将独立确认校准中所有真实触发过 option 的正负根共同用于近邻价值回归；动作概率增量仍来自与校准 SHA 绑定的 V16 H2 根。每个联合根依据其基础 reach row 的 source groups 原子分配到一个 canonical validation group；验证某个根时，训练邻居不得来自同一 group。

比较三种预先定义的低维表示：

- structural：街道、有效玩家数、位置、是否有位置、行动压力、筹码桶、SPR、下注轮级别、加注计数；
- balanced：在 structural 上加入手牌类别和公共牌纹理；
- tactical：在 balanced 上加入公共牌 texture class。

第一档要求相同 legal mask、similarity≥0.75、至少 3 个邻居。三种表示在两桌均 `scored=0`，说明当前 19/16 个联合根不足以支持这一邻域密度。预先限定的容量检查降低为 similarity≥0.5、至少 2 个邻居、最多 3 个，仍保持 legal mask 完全相同和 source-group 原子隔离：

| 表示 | 桌型 | roots | source groups | scored | selected | precision | mean actual selected LCB | passed |
|---|---|---:|---:|---:|---:|---:|---:|---|
| structural | 6 人 | 19 | 8 | 9 | 1 | 0% | -0.00024 | 否 |
| balanced | 6 人 | 19 | 8 | 2 | 1 | 0% | -0.00024 | 否 |
| tactical | 6 人 | 19 | 8 | 6 | 1 | 0% | -0.00024 | 否 |
| structural | 9 人 | 16 | 8 | 8 | 4 | 100% | +0.01121 | 是 |
| balanced | 9 人 | 16 | 8 | 5 | 2 | 100% | +0.01141 | 否（selected<3） |
| tactical | 9 人 | 16 | 8 | 7 | 4 | 100% | +0.01121 | 是 |

9 人桌证明低维联合表示能够跨 source group 泛化；但 6 人桌所有表示都把唯一选中的留出根误判为正，无法满足双桌安全门。因此 V18 不生成统一候选、不运行联赛、不进入正式复验。通过的 9 人桌工件仅保留为诊断，不得单独部署。下一阶段首先需要增加 6 人桌独立联合根，特别是当前稀缺的正收益根和相同 legal mask 的反例；继续调整相似度或邻居数会在已观察到 0% 精度的 6 人桌上过拟合。

## V19 6 人桌主动联合采样

V19 针对 V18 的 6 人桌数据缺口重新采集 16 个独立 seed clusters，保持混合对手、完整座位轮换、镜像和同一 HMAC source-group secret。新 reach 数据包含 3,218 次 QYZ 决策、2,952 个唯一精确根和 2,991 条完整基础策略分布。

从新数据分层选择 256 个根，使用 24 clusters × 8 rollouts 进行单步反事实校准；256/256 根成功，得到 190 个 actionable roots 和 288 个 actionable actions。与原 9 人桌完整 identity/guided rows 合并后形成 5,042 行、24 个 source groups 的训练集，并训练新的 9 成员 residual ensemble。group-disjoint test 覆盖率为 100%，mean shadow TV=0.00709。

新 6 人桌 H2 selector 的 leave-one-root-out 结果为 251/256 可评分、141 个选中、89.36% positive precision。联合 continuation pilot 从 128 个 selector 根得到 48 个真实可达根、33 个完整 horizon 根；独立 48 clusters × 8 rollouts 确认得到：

| reachable roots | controlled decisions | horizon reached | positive joint LCB roots |
|---:|---:|---:|---:|
| 48 | 20,738 | 2,306 | 19 |

这将 V18 的 6 人桌联合根从 19 增加到 48、正 LCB 根从 1 增加到 19、source groups 从 8 增加到 15。重新进行 source-group 原子验证：

| 表示/门 | scored | selected | precision | mean actual selected LCB | passed |
|---|---:|---:|---:|---:|---|
| structural，LCB≥0 | 46 | 18 | 61.11% | +0.01156 | 否 |
| balanced，LCB≥0 | 40 | 13 | 69.23% | +0.01344 | 否 |
| tactical，LCB≥0 | 46 | 14 | 50.00% | +0.01100 | 否 |
| balanced，LCB≥0.002 | 40 | 8 | 62.50% | +0.01703 | 否 |
| balanced，LCB≥0.005 | 40 | 6 | 66.67% | +0.02216 | 否 |
| balanced，LCB≥0.01 | 40 | 1 | 100% | +0.02912 | 否（selected<3） |

主动采样显著解决了数量和邻域密度问题，但仍未达到预设 75% 留出精度与至少 3 个选中根的联合门。提高价值阈值只能在剩余 1 个根时达到精度要求；structural/tactical 的精度随阈值提高没有稳定改善。V19 不生成双桌候选、不运行联赛、不部署，也不继续使用同一验证组调阈值。下一阶段需要学习校准概率或对失败模式分层，而不是继续扩大同一 kNN：重点检查 6 人桌联合收益是否受街道、legal mask 或锦标赛风险状态产生系统性符号翻转。

## V20 街道、mask 与位置分层符号校准

V20 分析 V19 的 6 人桌联合 LCB：`river|mask=4a` 与 `turn|mask=45` 均为 4/4 正，而 `flop|mask=5a`、`flop|mask=7d` 均为 0/3；9 人桌 turn/river 大多为正，preflop/flop 大多为负。收益符号具有明显的街道和 legal-mask 分层，而不是单调随全局相似度变化。

V6 builder 扩展四种精确分层预设，legal mask 始终独立要求完全相同：street、street+risk、street+position、street+texture。source-group 原子留出和最低 75% precision、3 个 selected 根的门保持不变。

6 人桌至少 2 个跨组邻居的验证结果：

| 分层 | scored | selected | precision | mean actual selected LCB | passed |
|---|---:|---:|---:|---:|---|
| street+mask | 33 | 10 | 80.00% | +0.01307 | 是 |
| street+risk+mask | 7 | 2 | 50.00% | +0.00291 | 否 |
| street+position+mask | 14 | 5 | 80.00% | +0.01041 | 是 |
| street+texture+mask | 0 | 0 | 0% | 0 | 否 |

为使用与 V19 新模型 SHA 绑定的 9 人桌策略，重新执行 16×4 pilot 和独立 48×8 confirmation；16 个可达根中 7 个为正联合 LCB，累计 6,703 次受控决策、559 次完整 horizon。相同 street/street+position 规则在至少 2 邻居时均 `scored=0`，因为同一 source group 原子移除后邻域不足。

最后的容量检查允许 1 个跨组邻居，但仍保持最低 3 个 selected 和 75% precision：

| 分层 | 桌型 | scored | selected | precision | mean actual selected LCB | passed |
|---|---|---:|---:|---:|---:|---|
| street+mask | 6 人 | 41 | 16 | 62.50% | +0.01082 | 否 |
| street+position+mask | 6 人 | 26 | 9 | 88.89% | +0.02111 | 是 |
| street+mask | 9 人 | 6 | 3 | 66.67% | +0.00683 | 否 |
| street+position+mask | 9 人 | 2 | 1 | 0% | -0.01217 | 否 |

没有一套相同分层规则同时通过 6/9 人桌，因此 V20 不生成联赛候选、不进入正式复验、不部署。V20 同时证明桌型之间存在不同的收益条件：6 人桌需要显式位置分层，9 人桌此前通过的是 structural/tactical 多维表示。下一阶段应允许 table-specific calibration heads，但部署门仍要求两个头各自在独立 source groups 和联赛中通过；共享 residual 基础模型不等于必须共享价值表示。

## V21 table-specific calibration heads

V21 保持同一个 V19 residual 模型、基础策略合同和合法动作投影，但允许 6/9 人桌使用不同的 V6 `featureOrder`。两个 head 分别绑定同一 residual model SHA，并继续强制 `tableSize` 隔离。

6 人桌冻结 V20 已通过的 `street+position+mask` head：26 个可评分根、9 个选中、88.89% precision、mean actual selected LCB=+0.02111。9 人桌使用与 V19 模型重新绑定的 H2 selector 和 V20 独立联合确认数据，重新比较 structural/balanced/tactical：

| 9 人桌表示 | scored | selected | precision | mean actual selected LCB | passed |
|---|---:|---:|---:|---:|---|
| structural，至少2邻居 | 8 | 1 | 100% | +0.01229 | 否（selected<3） |
| balanced，至少2邻居 | 5 | 0 | 0% | 0 | 否 |
| tactical，至少2邻居 | 7 | 0 | 0% | 0 | 否 |
| structural，至少1跨组邻居 | 12 | 3 | 100% | +0.01498 | 是 |
| balanced，至少1跨组邻居 | 9 | 3 | 66.67% | +0.00438 | 否 |
| tactical，至少1跨组邻居 | 12 | 2 | 100% | +0.01633 | 否（selected<3） |

冻结 6 人 position head 与 9 人 structural head 后，使用全新 `qyj-v21-table-head-diagnostic-*` namespace、完整轮换、镜像和 candidate/baseline 槽位交叉运行 2-seed 诊断：

| 桌型 | accepted / decisions | coverage | 动作变化 | mean TV | starts | continuations | aborts | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 13 / 866 | 1.50% | 1（0.115%） | 0.05394 | 13 | 0 | 6 | 0 | 0 |
| 9 人 | 9 / 1,106 | 0.81% | 2（0.181%） | 0.16175 | 9 | 0 | 2 | 0 | -0.42 |

两个 head 都达到最低覆盖、TV 和动作变化物质性，但没有一次 continuation；6 人桌结果与 QYZ 相同，9 人桌 HP 略负。两桌没有同时出现正向收益，因此没有启动 8-seed 正式复验，不部署，也不使用同一诊断集调阈值。V21 证明 table-specific value heads 可以安全共存，但当前联合校准根只足以触发首节点，无法在真实后续状态形成多步 option。下一阶段应把“后续状态可继续命中”作为训练目标，主动收集 option start 之后的 successor-state 分布，而不是只采集普通 QYZ reach roots。

## V22 option-induced successor-state 数据闭环

V22 新增 `--residual-successors` 联赛数据通道和 `qyj-residual-option-successors-v1` 工件。状态机在 option start 时保存起始 infoset；同一玩家下一次决策无论 continuation 成功还是 abort，都会记录 HMAC source group、start/successor infoset、两个 legal mask、拒绝原因和聚合计数。换手后状态清除，不跨 Engine、镜像或槽位交叉。原始 seed 和私牌不写入。

第一批使用 8 个全新 seed clusters、完整轮换/镜像/槽位交叉采集 successor 目标分布：

| 桌型 | rows | source groups | unique successor | attempts | continuations | aborts |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 22 | 8 | 22 | 23 | 6 | 17 |
| 9 人 | 11 | 5 | 11 | 11 | 1 | 10 |

主要拒绝原因为邻居不足（6 人 15、9 人 6）和 continuation value 不足（6 人 1、9 人 4）。只对这些真实 successor keys 运行独立 24×8 动作校准；22/22 和 11/11 根成功，所有根相对合法动作均值都存在显著最佳动作，说明后续状态具有可学习动作差异。

为获得真实 QYZ 基础分布，collector 进一步聚合同一 group/start/successor 内的完整 `baseStrategy`，并验证概率和为 1。第二批独立 8-seed 采集得到 6 人桌 10 个、9 人桌 6 个带基础分布的 successor；与第一批精确键交集为 0，再次证明分布高度离散。新增 `materialize-successor-base-rows.mjs` 将其转为 group-aware base rows，并用第三套独立 24×8 action seeds 校准相同第二批根：

| 桌型 | calibrated successor roots | actionable roots | actionable actions |
|---|---:|---:|---:|
| 6 人 | 10 | 10 | 13 |
| 9 人 | 6 | 6 | 9 |

V22 新增 `qyj-residual-successor-augmented-option-selector-v7`。首节点保持 V21 table-specific V6；只有已启动 option 的第二步才使用独立 successor guidance。6 人 successor head 使用 street/position/IP，9 人使用 structural 表示。全新 2-seed 诊断：

| 桌型 | accepted / decisions | starts | continuations | aborts | 动作变化 | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 12 / 650 | 12 | 0 | 5 | 0 | 0 | 0 |
| 9 人 | 10 / 1,197 | 10 | 0 | 5 | 1（0.084%） | 0 | +2.29 |

6 人桌第二步因 successor value/TV 门拒绝，9 人桌因 successor option TV 不足；两桌仍无成功 continuation，且动作变化率未达到 0.1% 物质性门。没有启动 8-seed 正式复验，也不降低同一诊断集上的 successor 门。V22 已建立正确的数据采集、基础分布和独立动作校准闭环，但 10/6 个第二批根仍不足以覆盖第三批新牌局。下一阶段需要跨多轮累积 successor 数据并按低维 successor signature 合并证据，而不是要求 start/successor 精确键跨批复现。

## V23 累积 successor signature head

V23 使用第三批全新 12 个 seed clusters 继续采集带 QYZ baseStrategy 的 option-induced successor。6 人桌新增 28 行、11 个 source groups，9 人桌新增 16 行、9 个 source groups；与 V22b source groups 完全不重叠。两轮累计得到 6 人桌 38 个、9 人桌 22 个唯一 successor exact roots。

第三批 successor 使用独立 24×8 action seeds 校准：6 人桌 28 个目标中 27 个通过 preflight，23 个 actionable roots、33 个优势动作；9 人桌 16/16 成功，15 个 actionable roots、16 个动作。新增 `merge-successor-training.mjs`，在验证 source-group secret、group 不重叠、合同一致和 exact roots 不重叠后合并多轮 guidance/base：

| 桌型 | cumulative guidance roots | actionable roots | base rows | source groups |
|---|---:|---:|---:|---:|
| 6 人 | 37 | 33 | 38 | 20 |
| 9 人 | 22 | 21 | 22 | 20 |

V23 新增 `qyj-residual-cumulative-successor-option-selector-v8`。V8 同时保留 actionable 与 non-actionable successor 根作为正反例，并按 canonical source group 留出验证第二步低维表示。两桌共同的 street + exact legal mask 表示通过：

| 桌型 | roots | validation groups | scored | selected | precision | mean actual selected LCB |
|---|---:|---:|---:|---:|---:|---:|
| 6 人 | 37 | 16 | 36 | 24 | 95.83% | +0.09953 |
| 9 人 | 22 | 12 | 17 | 17 | 94.12% | +0.09672 |

冻结 V21 首节点 heads 和 V23 street successor heads，使用全新 `qyj-v23-cumulative-successor-diagnostic-*` namespace 运行 2-seed 完整轮换、镜像和槽位交叉诊断：

| 桌型 | starts | continuations | aborts | coverage | 动作变化 | 名次优势 | HP 优势 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 6 人 | 12 | 1 | 3 | 1.48% | 3/876（0.342%） | -0.02083 | -35.10 |
| 9 人 | 3 | 1 | 1 | 0.38% | 1/1,054（0.095%） | 0 | +1.53 |

V23 首次在两桌新牌局中产生真实 continuation，证明累积 successor signature 解决了精确根不可复现问题。但 6 人桌配对排名和 HP 均为负；9 人桌覆盖与动作变化略低于物质性门。没有启动 8-seed 正式复验、不部署，也不使用同一诊断集重新调 successor 门。下一阶段必须对 successor 动作使用联合 continuation outcome 标签，而不是单步 action advantage：V23 的 source-group 动作精度很高，却未保证第二步动作之后的整段收益方向。

## V24 起点—后继路径条件续行头

V23 的 successor 采集物实际保留了 `startInformationSetKey` 与
`successorInformationSetKey`，但 V8 构建和执行时只使用后继键。V24 新增
`qyj-residual-transition-conditioned-option-selector-v9`，第二步必须同时匹配起始信息集、
后继信息集及两者的合法动作 mask。选择器同时绑定 residual 模型、动作优势 guidance
与 successor 来源文件的 SHA。

运行时 option 状态现在把起始信息集键传给 V9。训练验证仍按 canonical source group
整组留出，避免同一随机种子簇泄漏。V22b+V23 累计路径验证结果：

- 6 人桌：37 条路径、16 个来源组、33 条可评分、21 条入选，正例精度
  `95.24%`，入选实际 LCB 均值 `+0.10056`；
- 9 人桌：22 条路径、12 个来源组、15 条可评分、11 条入选，正例精度
  `90.91%`，入选实际 LCB 均值 `+0.07497`。

首轮影子联赛显示路径能匹配，但 QYZ 接近 0/1 的 base strategy 让正 LCB 动作偏移
仍低于物质性阈值，续行次数为 0。V24 因此加入只对正 LCB actionable action 生效的
最小 `1%` 概率偏移，并把单次 transition policy TV 硬限制为 `5%`。这一偏移不会对
无正下界动作扩张概率。

在全新 seed namespace 的 2-seed、全轮换、镜像联赛中：

- 6 人桌：840 次 residual 决策，8 次接受，5 次 option 启动、3 次真实续行、0 次
  中止；平均 TV `0.04736`，但实际动作变化为 0；相对 QYZ 名次与 HP 均为 0；
- 9 人桌：1041 次 residual 决策，5 次接受，4 次启动、1 次真实续行、1 次中止；
  覆盖率 `0.4803%` 低于 `0.5%` 门槛，平均 TV `0.05492`，实际动作变化为 0；
  相对 QYZ 名次与 HP 均为 0。

V24 修复了路径上下文丢失和确定性基线锁死续行的执行问题，但本批次没有产生真实
动作差异，因此没有强度收益证据。按硬门槛不运行 8-seed 正式晋级赛，不生成部署
schema，线上机器人继续使用 QYZ。下一步需要增加独立路径覆盖并用整条 option 的
paired outcome 直接校准“起始动作 + 后继动作”组合，不能再只扩大概率偏移。

## V25 联合轨迹价值门

V25 新增 `qyj-residual-joint-trajectory-option-selector-v10`。它不再把第一步的局部
动作优势和第二步的局部动作优势视为足够证据，而是使用共同随机数，成对比较完整
两步 option 与冻结 QYZ continuation 的锦标赛价值。只有至少一次真正到达 option
horizon 的根才进入轨迹训练；第一步由联合轨迹 LCB 头控制，第二步继续由 V9 的
`start + successor` 路径头控制。

同时修复了冻结联合校准器：V9 continuation 现在收到 option 的起始信息集键。由于
这会改变联合校准语义，evaluator 标识升级为
`qyj-joint-continuation-option-evaluator-v2`，旧 V17/V1 校准不能绑定到 V25。
V10 构建器要求 calibration SHA 精确绑定 V9 selector，并要求 group-aware base
dataset；验证仍为 canonical source-group-disjoint，默认至少 12 根、4 个来源组、
3 个入选根、75% 正例精度且入选实际 LCB 均值为正。

当前工作区没有保留正式晋级时的以下原始字节：

- `training/checkpoints/qyz-tv-v3.json`；
- `training/checkpoints/qyz-tv-v3-quality.json`；
- `training/checkpoints/qyz-targeted-tv-v3.json`。

旧 calibration 只保存这些文件的 SHA 和聚合证据，无法安全逆向恢复。V25 因而完成
代码、CLI、schema、运行时门控和测试，但按 provenance 规则拒绝生成伪造的 V25
calibration/selector，也不运行联赛和部署。要继续实际训练，必须恢复完全匹配旧 SHA
的三份文件，或重新执行 720-seed/桌的正式价值数据收集、质量晋级与 targeted
checkpoint 训练；不能用 pilot 模型替代。

## V26 真实 Engine 经验轨迹门

V26 在缺少旧正式价值模型原始字节时，增加不依赖近似叶价值的第二条证据路径。
联赛现在为 residual candidate 的每条 `start + successor` 路径记录 SHA-256 标识、
尝试/续行/终止次数和是否真正改变动作；报告不保存原始信息集键。经验指导器把候选
与 QYZ 在完整轮换、镜像、候选—基线交叉赛程中的最终名次和 HP 按 seed cluster
配对。输出 cluster ID 使用 HMAC，原始 seed 不进入指导文件。

新增 `qyj-residual-empirical-trajectory-option-selector-v11`。只有真实改变过动作、达到
最小独立 cluster 数，且所选 gate metric 的单侧下界为正的 transition 根才被保留。
即使能构建诊断头，正式 representation 门仍要求至少 12 个正根、每根至少 8 个
独立 cluster、累计至少 12 次动作变化。第一步保持 V9/V6 安全头，V11 只收紧第二步，
不会利用最终结果反向放宽局部价值门。

全新 `qyj-v26-empirical-trajectory-diagnostic-*` 2-seed 实际采集结果：

- 6 人桌：848 次 residual 决策、16 次接受、10 次启动、6 次续行、4 次动作变化；
  只有 1 条完整路径发生动作变化，覆盖 1 个独立 cluster。该样本名次优势 `+0.667`、
  HP 优势 `+862.5`，但单 cluster 没有可计算的统计下界；全局 HP 配对均值为
  `-42.81`，不能晋级；
- 9 人桌：1067 次决策、3 次接受、3 次启动、0 次续行、0 次动作变化，经验路径为 0。

因此 V26 成功建立了直接真实对局标签闭环，但正确拒绝了单样本正结果，没有生成
V11 selector、没有运行正式复验、没有部署。下一步必须扩大独立真实路径动作变化，
尤其是 9 人桌；在达到每根至少 4 个诊断 cluster 前不得拟合或降低经验门。

## V27 一致路径桶与8-seed真实轨迹复验

V26 使用实际路径精确哈希，而 V9 使用历史训练根精确哈希；泛化命中时两者通常不同，
导致真实结果无法归因到训练根。V27 改用与 V9 完全一致的匿名路径桶：起始低维特征、
后继低维特征和两个合法动作 mask 的 SHA-256。原始信息集仍不进入联赛报告。

8-seed、全轮换、镜像、候选—QYZ交叉结果：6人桌 3145 次决策、83 次接受、25 次
续行、4 次动作变化；名次优势 `-0.0052`，95% CI `[-0.0156, 0]`，HP 优势
`+8.52`，CI `[-6.82,+26.02]`。9人桌 4266 次决策、23 次接受、4 次续行、8 次
动作变化；名次优势 `-0.0035`，CI `[-0.0313,+0.0208]`，HP `+2.99`，CI
`[-10.10,+13.65]`。逐桶证据同样没有正的双指标下界。V9/V11 分支因此被否决，
不再为同一策略扩大样本。

## V28 生产 QYZ 对手适应先验

QYZ 已跨手维护 VPIP/PFR/3-bet/翻后激进与弃牌统计，但所有指标默认使用60手人口
先验；一局最多12手，使固定对手倾向被严重稀释。V28 保持生产 QYZ 默认不变，新增
离线候选测试20、12、30手先验，以及按指标机会数加权的20手版本。先验硬下限为12，
没有测试更激进设置。

所有诊断均使用各自全新8-seed、完整轮换、镜像和候选—QYZ交叉：

- 20手：6人桌名次 `+0.1146 [ +0.0260,+0.2031 ]`，HP
  `+85.12 [ -62.11,+241.14 ]`；9人桌名次 `+0.0139 [ -0.1389,+0.1910 ]`，
  HP `+36.89 [ -64.32,+154.10 ]`；
- 12手（仅9人）：名次约 `0 [ -0.1181,+0.1250 ]`，HP
  `+17.99 [ -52.81,+95.09 ]`；
- 机会数加权20手：6/9人名次均值均为负，否决；
- 30手（仅9人）：名次 `-0.0174 [ -0.1563,+0.1076 ]`，HP
  `-7.40 [ -92.59,+88.77 ]`。

20手统一先验冻结为当前最优研究候选，但双指标门未通过，不能上线。后续停止搜索
先验数值，转向9人桌多路底池结构误差；6人桌的正名次下界必须在最终组合策略的
独立确认集中重新出现，不能复用本轮调参数据。

## V29—V31 多路弃牌与连续锦标赛风险

V29 修复多路下注时的结构偏差：旧模型使用平均对手弃牌概率的 N 次幂，异质玩家
混桌时会高估全员弃牌概率；新模型逐对手计算概率乘积，并由异质 Bernoulli 分布求
“至少一人继续”条件下的期望跟注人数。9人桌8-seed均值改善为名次 `+0.0521`、
HP `+53.57`，但下界跨零；6人桌转负。V30 按桌型组合 V28/V29，在全新确认集
仍未通过。

V31 把旧的三档锦标赛风险改成可选连续百分位风险：前40%赛程为0，领先者中后程
最多增加7.5%权益要求，短码最多降低5%。8-seed诊断中9人桌一度双指标通过，6人桌
均值也明显为正，因此冻结参数进入24-seed确认。最终确认结果：

- 6人桌：名次 `+0.0191 [-0.0469,+0.0851]`，HP
  `+32.34 [-60.15,+126.67]`；
- 9人桌：名次 `+0.0081 [-0.0880,+0.1007]`，HP
  `+4.56 [-72.67,+84.48]`。

效应在更大独立样本中消失，V31 被否决，不切换生产默认。下一阶段不再搜索全局
风险/先验系数，改用决策级公共节点反事实证据，只允许有独立正收益下界的具体动作
差异进入候选，从而降低完整终局结果的归因方差。

## V32—V33 真实 Engine 单节点反事实回放

新增确定性强制动作回放：冻结 QYZ 先用相同 deal seed、座位和对手跑基线，再重放
完整12手，只在目标玩家的指定决策序号替换一个合法动作，之后恢复冻结 QYZ。测试
验证分支在相同公共信息集到达目标节点。输出按 HMAC seed cluster 聚合名次/HP差，
不保存原始 seed。

随机目标 V32a 因字符串排序优先抽到 all-in，正确显示强制全下显著为负，但不能用于
寻找改进。V32b 修复自然动作顺序并使用低维结构；一个9人早位 call→fold 在2个
cluster 中看似为正，但16-cluster新集零命中，因不可复现否决。

V32d 先独立画像高频签名，再冻结动作假设：

- 高频 raise:feint→call：6/9人桌12-cluster双下界均为负；
- 高频 fold→call：6人桌135次、9人桌86次，名次下界分别 `-0.1180`、`-0.9679`；
- 高频翻牌 check→raise:feint：6/9人桌双下界均为负。

V33 加入自有牌力摘要、牌面桶和SPR做翻后分层。24-cluster确认中，6人桌干燥高牌面
空气诈唬覆盖11个cluster/13次，名次均值 `-0.273`、HP `-576.36`；9人桌低牌面
半诈唬仅命中1次且HP `-1170`。两条规则均否决。

结论：QYZ 高频翻前紧度、小加注以及常见翻牌过牌没有发现可部署漏损。下一步反向
检查成牌价值下注尺度，优先测试中注降为小注和小注降为过牌，仍要求动作级双指标
正下界后才进入完整联赛。
# V34–V52：动作回放、正式赛事价值重建与候选否决（2026-07-13）

本轮没有切换线上 QYZ。所有新增策略均通过显式离线开关注册；生产默认仍为 `qyz`，原因是没有候选同时通过 6/9 人桌的名次与 HP 配对置信下界。

## 决策级反事实与翻前 EV

- V34–V35 对高频价值下注和局部最高 EV 动作做真实 Engine 强制分支回放。样本不足或收益 LCB 为负；“局部最高 EV”在 6/9 人桌均未形成可部署优势。
- V36 统一翻前下注 EV 在 9 人桌产生名次信号，但 HP 未通过。
- V37–V39 对赛事风险作用街道做消融；同种子复验表明正向结果不可复现。
- V40–V43 依次测试多人联合权益投影、收缩投影和逐对手直接单挑权益。它们修复了动作强度口径，但独立联赛未形成双指标稳定优势。
- V48–V52 分别测试纯 chip-EV、20-hand 先验、充分统计可靠度、three-bet 机会分母和“统一翻前 EV + Prior20”。所有 8-seed 边缘信号均在 24-seed 冻结确认中消失或转负。

关键冻结确认：

| 候选 | 桌型 | seeds | 名次优势 95% CI | HP 优势 95% CI | 结论 |
|---|---:|---:|---:|---:|---|
| V48 chip-EV only | 9 | 24 | -0.03935 [-0.07755,-0.00347] | +0.07 [-18.91,+22.37] | 名次显著变差 |
| V51 three-bet opportunities | 6 | 24 | -0.01215 [-0.10938,+0.07292] | -6.33 [-154.87,+136.61] | 效应消失 |
| V52 consistent EV + Prior20 | 9 | 24 | +0.01389 [-0.14583,+0.17593] | -57.28 [-187.99,+74.35] | 未复现 |

## 正式赛事价值 V4 产物

重新采集了真实 Engine 的 6/9 人桌公共续局状态：

- Dataset：`training/datasets/qyj-tv-v4-formal.json`
- 251,492 条公共状态、1,440 个独立 seedGroup；每桌型 720 组，严格拆分 504/108/108 train/validation/test。
- Dataset SHA-256：`92f8fcd16aa0622f5c38ed1d7829604ac0d1ffc43883f49681d0d9bf98f5aeb5`
- Model：`training/checkpoints/qyj-tv-v4-formal.json`
- Model SHA-256：`7d401c76ea32ea5d6ea9f501bad2118349e547b2e1576ba4daa384d83dcab3c2`
- Quality report：`training/checkpoints/qyj-tv-v4-formal-quality.json`，`promotion.passed=true`。

正式 test：6 人桌 RMSE 相对筹码排序基线改善 16.39%，9 人桌改善 18.04%；两桌型 cluster CI 下界均大于 0，OOD 覆盖均高于 99.9%，裁剪率 0，168,983 次单调性测试 0 违例，联合价值最大定和误差 `1.33e-15`。

V44 将模型曲率压缩为单一运行时风险阈值后，6/9 人桌均负向，因此只保留模型基础设施，不启用 V44 策略。

## V45b 动作级 continuation

用同一内存 HMAC secret 采集 group-disjoint reach：

- 6 人桌训练/留出：64/16 组，12,665/3,284 决策；
- 9 人桌训练/留出：64/16 组，18,258/4,469 决策；
- 四份 profile fingerprint 相同，train/holdout 交集为 0；
- 训练 profile SHA：6 人桌 `0b64c0aa827872e8797858cebe98e4e2d701b55d1ed1d3dc3e9d02d41bc915b5`，9 人桌 `8a20720cfd96f1aa96db1fa65e7842f85973fa640d4a6a5c12cb95f17b1e0554`。

赛事价值根预检从 510 个 exact key 中 fail-closed 拒绝 1 个 `root-ood`，其余 509 根、1,686 个公共变体各训练 100 次真实 traverser 更新。安全 checkpoint：

- `training/checkpoints/qyj-v45b-targeted-tv-safe.json`
- SHA-256：`d3b24a06f6936a1ac3cebeaab80d179aa1223a7de380a18f0e490a2443ce87b9`
- 10,045/10,045 根预检通过，raw chip fallback 为 0，约 1,296 万 utility samples。

但独立留出 exact 覆盖仅为 2.13%/1.21%，理论 argmax 变化上限仅 0.76%/0.36%。保守 backoff 只发布 4 个 strategic 与 4 个 population 节点，实际 advantage pass、intervention、action change 仍全为 0，因此没有运行正式收益联赛。

## V46–V47 residual

同一 fingerprint 的一体化流水线采集 residual source、训练联合 V3 shadow 模型并在全新 8 组上评估：覆盖约 94.75%/94.75%，mean shadow TV 约 0.00574/0.00402，但假想 argmax 变化只有 0.204%/0.127%。

对实际 residual 行覆盖的 49 个根执行 20 cluster × 4 CRN rollouts，得到 4 个正 LCB 根、5 个动作。稀疏 selector 仍在真实联赛中接受 0 次；主要拒绝为 policy TV 不足、层级回退超过限制和校准根距离过远。没有放宽这些安全门，V47 保持 shadow-only。

## V53–V61 在线求解迁移与真实 Engine 策略改进

V53–V59 加入确定预算的公共信念在线子博弈求解器，叶节点绑定正式 tournament-value V4 模型，并用独立 CRN 根校准决定临时 checkpoint 是否可执行。V55 深翻后正式 8-seed 结果为：6 人桌名次 `-0.08854 [-0.22396,+0.04167]`、HP `-2.86 [-85.21,+63.44]`；9 人桌名次 `+0.02778 [-0.09722,+0.15625]`、HP `+29.95 [-86.60,+177.43]`。V59 桌型定制版在全新 8-seed 中同样失败：6 人桌名次 `-0.04167 [-0.08333,+0.00521]`、HP `+26.35 [-66.28,+106.04]`；9 人桌名次 `-0.06944 [-0.25694,+0.09722]`、HP `-47.96 [-152.45,+40.12]`。

V60 新增真实 Engine 干预迁移选择器：对在线求解器提出的动作做同发牌、同座位、单节点恢复 QYZ 原动作的完整比赛重放，并按动作对、桌型、公共特征和 HMAC 独立簇计算名次/HP 双下界。训练集包含初始 88 个和定向 62 个反事实分支；完整影子轮换中 6/9 人桌最终动作变化均为 0，求解器变化主要因邻居不足、独立证据不足或双 LCB 非正被拒绝。

V61 取消在线求解器提案，直接用真实 Engine 强制分支库审核每个合法替代动作。旧库 474 个分支之外新增 6 人桌 367 个、9 人桌 545 个全动作分支，合并为 755 个去重根。全新影子种子中仍为零动作变化：6 人桌 397 个决策中 222 个的候选动作被双 LCB 判负；9 人桌 538 个决策中 322 个被判负，其余主要缺独立证据。扩大真实数据后，单节点策略替换的正收益假设反而得到更强拒绝，因此 V60/V61 均保持 offline-only。

## 当前发布结论

- 正式赛事价值模型通过模型质量门，但没有候选策略通过实战双桌双指标门。
- V34–V52、targeted checkpoint、backoff、residual 和 selector 均未复制到静态生产资源。
- 线上机器人仍使用经过完整回归的原 QYZ；不得宣称达到世界顶级职业牌手水平。
- 下一阶段应构建真实 Engine 多步公共信念 rollout planner：对完整的后续自身决策序列做重确定化/公共信念采样，而不是继续评估孤立单步动作；仍需使用独立对手池、更长赛程和 6/9 人桌双指标硬门验证。

## V62–V72：真实 Engine 公共信念 rollout、标签确认与在线双阶段求解

V62 新增 `qyj-public-belief-engine-rollout-v1`。每个候选动作都从同一个只含公开信息的根开始，对未知对手底牌和未来公共牌重新确定化，再由禁用技能的真实 Engine 走到本手结束。所有首动作共享 deal/continuation 随机数，并以相对冻结 QYZ 动作的配对 HP 下界选动作。隐藏状态只来自 allow-listed 公共信念采样器，真实底牌不进入目标输入。

6/9 人桌各生成 512 个 reach 根，分别得到 58/64 个首轮正根、15,078/14,928 个效用样本且 0 错误。简单 KNN、规则和哈希线性动作价值蒸馏均未通过来源隔离验证；线性模型在校准集最高分区间仍以负 LCB 为主，因此全部保持 offline-only。

V64 使用全新 namespace 将首轮正根提高到 24 个 belief clusters 独立确认。6 人桌只有 16/58 再次接受、10 个保持相同动作；9 人桌只有 19/64 再次接受、9 个保持相同动作。确认后的精确 selector 保留 32 条 LCB>=5 记录，但在 8-seed 新 reach 探测中，6 人桌 648 次、9 人桌 1,028 次决策均为 0 命中，所以未进入收益门。

V65–V72 针对在线延迟重构 continuation。生产 QYZ 的 180–560 次范围权益预算保持默认不变；候选可显式使用缩放预算。确定性 fast-public continuation 只使用每个模拟玩家自己的采样底牌、公共牌、牌力和底池赔率，禁止把任何对手隐藏牌暴露给决策者。它在基准根上达到约 35 倍加速，但 9 人桌存在虚假强加注，因此 V67 起采用两阶段 fail-closed：第一层 24/32 clusters fast-public 筛选，第二层用独立 namespace 和 16/24 clusters 的缩放 QYZ continuation 只确认“基线动作 vs 候选动作”。两层 LCB 都为正才允许改写。

V72 桌型配置为 6 人桌 24+16 clusters、9 人桌 32+24 clusters。全桌 8-seed 覆盖探测得到 6 人桌 5/678=0.737%、9 人桌 8/1,029=0.777%，均越过预设 0.5% 动作变化门。随后执行完整平衡正式赛：6 人桌 192/192 场、9 人桌 288/288 场，8 个独立 seed clusters、全座位、镜像以及候选/QYZ 逻辑槽位交换全部完成，Engine 错误为 0。

正式收益结果拒绝 V72：

- 6 人桌 18/2,948=0.611% 改写，rank 优势 95% LCB=-0.015625，HP 优势 LCB=-23.515625；
- 9 人桌 45/4,222=1.066% 改写，rank 优势 95% LCB=-0.100694，HP 优势 LCB=-59.930556；
- 两桌收益均值也接近零或略负，不能把覆盖通过解释为强度提升；
- 在线候选仍有 `online-resolver-offline-only-cannot-deploy` provenance 阻断，生产 QYZ 未替换。

下一阶段不再单纯扩大 clusters。应在平衡赛中持久化每次 intervention 的街道、动作对、screen/confirmation LCB、状态特征和 seed-cluster 最终结果，按 seed/source group 隔离训练第三层 accept/reject 校准器；该校准器必须重新通过 0.5% 覆盖、双桌 rank+HP 正下界、安全回归和延迟门。

## V73：单次干预真实 Engine 反事实门（2026-07-13）

V73 新增单次干预采集器。候选局先按 V72 完整运行；每次实际动作改写再使用相同 deal seed、相同座位和相同决策序号重放，只把该节点恢复为基础 QYZ 动作，其余后续策略保持 V72。数据只保存公共信息特征、两层 rollout 摘要、HMAC seed-cluster ID 与候选相对基础分支的排名/HP 差，不保存任何玩家底牌。

正式开发数据全部完整轮转、镜像且重放错误为 0：

- training：6 人桌 9/814 次改写，9 人桌 14/1,088 次改写；另保留 2-seed pilot 作为训练证据；
- calibration：6 人桌 4/789 次改写，9 人桌 19/1,206 次改写；
- untouched test：6 人桌 10/792 次改写，9 人桌 12/1,101 次改写；
- train/calibration/test 使用不同 namespace；模型保存开发 cluster 哈希，测试时再次强制检查 seed-cluster 不相交。

第三层采用保守伤害拒绝门：默认保留 V72，只允许拒绝在 training 中达到至少 4 个独立 cluster、HP 与排名上置信界均不正，并在 calibration 至少 2 个新 cluster 再次为负的“桌型 + 街道 + 动作对”。开发数据只确认一条规则：9 人桌 turn `check => allin`；training 4 个 cluster 的 HP/排名上界均为 0，calibration 3 个 cluster 的 HP 均值为 -135.28、排名均值为 0。

冻结规则后的 untouched test 未通过：

- 规则在 9 人桌 test 中命中 0 次，无法获得独立规则确认；
- 6 人桌保留干预覆盖 1.263%，排名 LCB 0，但 HP LCB -70.41；
- 9 人桌保留干预覆盖 1.090%，排名 LCB -0.896，HP LCB -2,102.34；
- test 报告 `passed=false`，V73 没有注册到策略表，也没有进入正式收益联赛或生产部署。

该结果否定了仅按动作对修补 V72 的路线。下一阶段要校准 rollout 估计与真实 Engine 收益之间的映射，重点检查两层 LCB、底池归一化置信度、街道与动作风险的单调关系；现有 untouched test 已封存，不得用于调参，新模型必须使用新的最终测试 seed。

## V74：9 人桌归一化置信尾部上限（2026-07-13）

仅使用 V73 的 training/calibration 开发数据审计固定阈值网格。9 人桌在 `confirmation.lowerBound / pot > 0.125` 的尾部，training 平均为 -1,662.5 HP/-0.5 名次，calibration 平均为 -81.25 HP/-0.25 名次；保留区 calibration 为 +49.67 HP/+0.067 名次。6 人桌的扩展 calibration 中唯一高尾样本为 +3,220 HP/+1 名次，明确否定跨桌外推。因此 V74 只在 9 人桌应用 0.125 上限，6 人桌保持 V72；它仍是显式 offline candidate。

全新 4-seed 平衡诊断中，6/9 人桌动作变化覆盖分别为 0.804%/0.748%，排名与 HP 均值均为非负或正，但下界跨零。按预先流程进入全新 8-seed 正式确认：

- 6 人桌 192/192 场、0 Engine 错误，18/2,713=0.663% 改写；排名优势 `+0.015625`，95% LCB `-0.010417`；HP 优势 `+43.5677`，LCB `+6.2240`；
- 9 人桌 288/288 场、0 Engine 错误，39/4,269=0.914% 改写；排名优势 `+0.034722`，LCB `-0.027778`；HP 优势 `+24.8090`，LCB `-31.4063`。

V74 首次在独立正式集清除了 6 人桌 HP 下界，但 6 人桌排名和 9 人桌双指标仍未通过。均值改善不能替代硬下界；不解除 `online-resolver-offline-only-cannot-deploy`，不切换生产 QYZ，也不在看到失败后继续为同一阈值可选加样。

## V75–V77：赛事价值动作门与本手生存非劣门（2026-07-13）

检查 V62 rollout 后发现旧实现监听 `onPotAwarded` 并立即返回主角 HP，没有等待 `onRoundEnd` 完成淘汰排序。新实现改为在回合结束边界停止，并保留三种互不混用的离线目标：旧 HP、HP + 正式 tournament-value V4 双下界、HP + 本手生存差。

V75 在第二阶段同时要求 HP 配对下界和风险调整赛事价值配对下界非负。4-seed 全平衡诊断中覆盖降至 6 人桌 0.277%、9 人桌 0.344%，排名均值分别 -0.0313/-0.0486，9 人桌 HP 均值 -60.35。正式赛事模型适合预测较长赛程结果，但其微小单动作差分不具备足够因果稳定性；V75 在正式确认前否决。

V76 改用同 belief deal 下的本手生存 {-1,0,+1} 配对 LCB。双表收益均值转正或非负，但覆盖仅 0.219%/0.457%，严格小样本生存下界过度保守。V77 保留“候选观察到的出局次数不得多于基础动作”，把生存门改为配对均值，HP 仍使用正 LCB。4-seed 诊断恢复 0.556%/0.688% 覆盖且双表均值非负，因此进入全新 8-seed 正式确认。

V77 正式结果：

- 6 人桌 192/192 场，10/2,902=0.345% 改写；排名优势 `-0.005208`，95% LCB `-0.015625`；HP 优势 `+22.3438`，LCB `+1.1719`；覆盖与排名失败；
- 9 人桌 288/288 场，31/4,292=0.722% 改写；排名优势 `-0.003472`，LCB `-0.076389`；HP 优势 `-18.4375`，LCB `-96.6667`；收益失败。

V75–V77 全部保持 offline-only。结果说明单一手工风险门无法稳定刻画动作对整段赛程的因果效果。下一阶段使用已收集的真实 Engine 单动作反事实结果，按 seed/source group 隔离训练连续伤害模型；最终仍需全新双表正式集验证，不能复用 V73–V77 的测试结果调参或晋升。

## V78–V82：连续伤害模型、真实分支审计与风险转换约束（2026-07-13）

V78 新增 cluster-aware 连续因果伤害门。模型只使用公开信息、动作对、两阶段 rollout 摘要和真实 Engine 同 seed 强制分支结果；模型只能拒绝 rollout 提议，不能创造动作。85 条既有开发记录只有每桌 14 个独立 cluster，高维模型不可辨识，因此采用连续邻域估计、留一 seed-cluster 校准和默认放行。第一版 6 人桌覆盖仅 0.149%；保守版恢复到 1.286%，但 4-seed 诊断仍为排名 `-0.0104`、HP `-21.41`，否决。

采集器随后补齐以下评测能力：

- 同时记录 harm-gate 拒绝提议和保留提议；
- 对拒绝提议额外强制执行原动作，和基础 QYZ 分支做完整 Engine 对照；
- 支持候选↔QYZ 逻辑槽位 crossover，和正式联赛调度一致；
- 支持 seed offset，允许只补采指定独立 seed；
- 每条记录保留 `gateDisposition`、公开 gate 预测和 HMAC cluster ID，重放错误必须为 0。

V78 失败诊断的精确分支回放表明：18 次保留动作的排名效应全部为 0，HP 合计 -455；6 次拒绝动作全部为 0/0。均值型伤害门没有识别到真正损失。V79 尝试非对称尾部损失概率，但留一 cluster 验证会同时拒绝高方差正收益动作，开发门未通过，生成 fail-closed 空模型，没有注册运行候选。

V80 在 6 人桌加入 `confirmation.lowerBound / pot >= 0.0075` 下限。历史开发样本和 V78 精确 A/B 均值改善，但全新 4-seed 中没有提议落在新增下限区间，实际 22/1,395=1.577% 改写；联赛排名 `-0.1354`、HP `-115.52`。随后 22 条精确分支审计得到平均 `-350.23 HP/-0.5 rank`，确认不是单纯联赛噪声。

该审计把主要损失定位到 `call => allin`：8 条、3 个独立 cluster，平均 `-1,039.38 HP/-1.75 rank`。V81 在全部桌型禁止 rollout 把基础跟注直接升级为全下，但不影响基础 QYZ 自己选择全下。全新 4-seed 结果：

- 6 人桌 12/1,400=0.857% 改写，排名均值 0、LCB -0.0625，HP +61.41、LCB -18.96；方向改善但置信门未过；
- 9 人桌 24/2,239=1.072% 改写，排名 -0.00694、HP -28.81；否决。

历史 9 人桌真实分支显示 flop/river `check => allin` 同样负向。V82 仅在 9 人桌禁止这两条转换并保留 turn `check => allin`。全新诊断覆盖崩为 2/2,080=0.096%，排名均值 +0.00694、LCB 0，HP -0.83、LCB -2.5。V82 因覆盖和 HP 同时失败而否决。

V78–V82 全部保持 offline-only；生产 QYZ 没有切换。结果说明继续删除风险动作会使 9 人桌覆盖低于硬门。下一阶段应保留动作空间，使用累计真实强制分支样本学习按桌型/街道校正 public-belief rollout LCB 到真实 Engine 效应的映射，并用全新 seed 做最终测试；不得复用上述诊断集宣称晋级。

## V83–V98：真实 Engine 价值校准、局部因果覆盖与桌型隔离（2026-07-14）

V83 新增低维 ridge 价值校准器。输入仅含公开状态、动作转移、底池归一化 screen/confirmation 统计和基础/候选激进度；目标为真实 Engine 强制分支的 HP 与 rank 差。训练按 HMAC seed cluster 等权，超参数使用留一 table+seed-cluster 验证。校准器只允许拒绝或回退，不创造新动作，产物始终带 `offline-evaluation-only` 阻断。

V84–V86 加入桌型阈值、`call=>allin` 结构封锁和扩大候选召回。V86 的 4-seed 诊断为：

- 6 人桌覆盖 0.800%，rank `+0.03 [-0.06,+0.16]`，HP `+44.5 [+4.2,+88.6]`；
- 9 人桌覆盖 0.400%，rank `+0.02 [-0.01,+0.05]`，HP `+60.4 [-25.1,+198.3]`。

收益方向改善，但 9 人桌覆盖和双下界未过。V86 的 9 人桌强制分支审计完成 37 条记录、4 个 cluster、0 重放错误；被拒组均值 `+279.48 HP/+0.345 rank`，显示线性门对部分 turn/river `check=>allin` 过度保守。

V87–V92 分别测试重拟合阈值、提高 confirmation clusters、HP/rank 双目标 floor 和动作转移屏蔽。它们揭示覆盖与风险之间的连续权衡，但没有同时通过三项筛选线：V89 收益双正但覆盖仅 0.141%；V91 覆盖 0.4921%、rank `+0.0139`、HP `+25.42`，仍严格低于 0.5%；V92 屏蔽负收益 `=>raise:feint` 后覆盖降到 0.233%。这些版本全部否决。

V93 在累计 212 条、54 个独立 cluster 上训练 7-neighbor、bandwidth 1.2 的局部因果门。它只在 V86 线性门因价值不足拒绝时尝试正向覆盖，且要求 nearest distance ≤2、effective clusters ≥4、HP/rank 在 0.5 个标准误后仍非负；结构风险拒绝不可被覆盖。全新 9 人桌诊断首次同时通过筛选均值和覆盖：16/2,166=0.739%，rank `+0.0278 [-0.0278,+0.0833]`，HP `+59.17 [+3.89,+128.92]`。但相同覆盖用于 6 人桌时 HP/rank 转负，因此不能跨桌型部署。

V94–V97 将局部覆盖限制为 9 人桌，并在 6 人桌测试扩大初筛、24-cluster confirmation、HP floor 与 rank floor。6 人桌结果在不同新种子间表现为：覆盖可从 0.221% 提升到 0.900%，但 HP 与 rank 无法在同一版本同时保持非负。V97 的同分布强制分支审计得到 36 条记录、4 个 cluster、0 重放错误；10 条放行提案均值 `+127.5 HP/-0.1 rank`，26 条拒绝提案均值 `+70.19 HP/-0.077 rank`，确认当前 6 人桌候选生成普遍存在“筹码正向、名次负向”的结构冲突。

V98 将上述 24-cluster 数据加入 248 条、58-cluster 校准集，并为 6/9 人桌解析不同检查点。开发交叉验证投影 6 人桌覆盖 0.561%、保留组 HP LCB `+0.095`，但全新 4-seed 诊断仍为覆盖 0.8%、rank `-0.09`、HP `-53.9`，否决，说明线性同分布重训仍然过拟合。

当前结论：V83–V98 全部为离线候选，生产 `qyz` 从未切换。9 人桌 V93 已达到 4-seed 筛选线，但 6 人桌尚无同版本双正候选，因此未运行 V98 正式 8-seed 双桌门，也不得宣称已达到世界顶级职业牌手水平。下一阶段必须重构 6 人桌 rollout 的候选效用：在候选生成阶段联合优化 HP、淘汰/名次和整段后续策略，而不是继续调整接受阈值；随后仍需全新 4-seed 筛选、8-seed 双桌 rank+HP 正下界、技能开启和合法动作安全回归。

## V99–V103：多目标候选生成与风险受控确认（2026-07-14）

V99–V101 将旧的“HP 选一个动作、赛事价值只做事后确认”重构为两阶段多目标候选生成，并支持按赛事价值均值初筛、Top-K 候选进入独立 LCB 确认。V101 首轮暴露 `screenCandidateCount` 接入错误，326 次翻牌后决策全部异常回退；修复后同种子覆盖恢复到 0.5%，rank 持平但 HP 为 `-38.4`，因此否决。该缺陷已有回归测试，Top-K 最终动作也改为确认阶段真正选中的动作。

V102 在确认阶段同时要求 HP、风险调整赛事价值与当前手存活率的配对下界非负。全新 4-seed 6 人桌筛选达到覆盖 1.5%、rank `+0.10 [-0.03,+0.34]`、HP `+56.7 [-3.0,+173.1]`。随后全新 8-seed 正式集覆盖 19/2,826=0.672%，rank `+0.0417 [-0.0104,+0.1042]`、HP `+25.99 [-22.29,+91.41]`；均值双正但下界未过，仍不得晋升。

正式审计显示 V102 的 19 次动作改动中 10 次为主动 all-in，且 26 次末回合 rollout 因 `round=12` 被非终局模型校验拒绝。V103 将第 12 回合存活叶正确按最终排名计值，6 人桌禁止 rollout 主动选择 all-in，并让 Top-3 非 all-in 候选进入三重确认；9 人桌继续冻结 V93 的 Top-1 路径。V103 当前仍为离线候选，生产 `qyz` 未切换，下一步必须使用全新种子重新通过 4-seed 筛选和 8-seed 双桌正式门。

V103 全新 4-seed 6 人桌筛选中，主动 all-in 与末回合异常均降为 0，rank/HP 优势为 `+0.0208/+0.2083`，但仅改动 2/1,398=0.143%，低于 0.5% 作用门。V102 正式动作审计显示 10 次 all-in 中 6 次位于 river，前中期高方差主要来自 flop/turn。V104 因此只恢复 river 主动 all-in，继续禁止 flop/turn all-in 与 `call→allin`，并保留 Top-3 三重确认；仍需全新种子验证，不得直接晋升。

V104 全新 4-seed 筛选覆盖 5/1,265=0.395%，rank 持平、HP `-31.67`，未过双正与 0.5% 作用门；动作改动为 3 次 `strike→feint`、1 次 `allin→call`、1 次 river `check→allin`，且无末回合异常。V105 保持动作风险边界和所有三重 LCB 门不变，把独立确认从 24 增加到 32 簇并让 Top-4 候选参与确认，以降低确认估计方差而不是放宽阈值。

V105 全新筛选覆盖 4/1,379=0.290%，rank/HP 优势 `+0.0104/+0.625` 且下界均为 0，但平均每次候选决策约 8,602 个效用样本，覆盖与线上延迟均不合格。V106 改为低延迟公开信息直接因果策略：枚举合法动作并查询 V93 的 212 条、54-cluster 真实 Engine 配对结果，只在局部 HP/rank 的 0.5 标准误下界同时非负、距离不超过 2、有效 cluster 至少 4 时改动；不再执行在线 rollout，仍保留 6 人桌前中期主动 all-in 限制。

V106 首轮注册键未使用联赛识别的 `online-resolver-` 前缀，虽然完成 96 局且候选相对基线 rank `+0.0104`、HP `-7.29`，但干预覆盖未被计入报告；该轮仅作为接入诊断，修正注册键后必须重新评测，不能用于晋升。

V106 修正遥测后的全新 4-seed 筛选覆盖 27/1,278=2.11%，但 rank `-0.333 [-0.719,-0.063]`、HP `-161.5 [-321.3,-27.6]`，明确否决。27 次改动中 7 次为 `call→fold`、14 次为 river `check→allin`，表明缺少 rollout 摘要时局部模型会过度选择极端动作。V107 禁止直接模型主动改为 fold/all-in，将置信系数收紧到 0.75、最大邻域距离收紧到 1.5；基础 QYZ 原本选择的 fold/all-in 不受影响。

V107 全新筛选仅产生约 0.1% 改动，候选与基线 rank/HP 完全持平，说明既有公开因果邻域在排除极端动作后证据不足。V108 扩展强制分支采集器，新增 postflop 街道过滤与替代动作排除；以 6 个独立 HMAC cluster、全座位轮换/镜像采集 276 个非 fold/all-in 完整比赛反事实、126 个签名。与 V32/V61 数据合并后得到 836 个去重根的直接真实 Engine 策略选择器，保持至少 6 cluster、24 样本和 rank/HP 双 LCB 正门，6 人桌继续禁止模型主动改为 fold/all-in。

V108 全新 4-seed 筛选产生 0 次动作变化：809 个候选被真实 Engine rank/HP 双 LCB 判负，404 个缺独立 cluster，69 个缺邻居。结果确认当前瓶颈不是阈值或样本量的小幅不足，而是“只改一个节点、后续仍回到旧 QYZ”的策略类本身没有稳定正改进。下一阶段应训练并验证跨街连续动作 option/trajectory，让改进动作与后续策略共同变化；在新的多步候选通过新种子双桌门前，生产 `qyz` 保持不变。

## V109–V112：两步公共信念 option（2026-07-14）

V109 新增 `qyj-public-belief-two-step-option-v1`。每个候选由首动作和同一玩家下一次行动的 `control`/`pressure` 续行组成；所有计划共享公共信念 deal，快速筛选与高精度确认使用独立 namespace，并同时要求 HP、风险调整赛事价值和本手存活三项配对门。续行必须在至少 50% 的有效 belief clusters 中实际到达，运行时状态按 Engine/玩家/回合隔离且只消费一次。2-seed 冒烟中出现 4 次真实改动（2 次 option start、2 次 continuation），rank/HP 为 `+0.0417/+57.92`；全新 4-seed 筛选只剩 3/1,425=0.211% 动作变化，rank `0`、HP `+2.29 [-0.63,+7.50]`，覆盖和双下界均未通过，因此否决。

V110 把续行扩展为按牌力、听牌潜力、底池赔率和下注尺度选择的 `control`、`thin-value`、`polarized`。全新冒烟 0 次介入，并有 7 个根被单一候选的赛事价值 OOD 连带中止。V111 将失败隔离到候选计划，只在相同有效 cluster 上配对统计，并要求计划有效率至少 90%；OOD 整根失败消失，但仍为 0 次介入。V112 将快速层改为 HP/赛事价值/存活均值 Top-3 召回，高精度层继续要求三项 LCB 非负；80 个根进入确认但无一通过，48 场耗时升至 354 秒。结论是失败来自手工 option 本身，而不是快速层假阴性；V109–V112 全部保持 offline-only。

## V113–V117：锦标赛感知 MCCFR 目标与深筹码课程（2026-07-14）

V113 为 2–9 人抽象 MCCFR 新增零和 `hybrid-tournament` 效用：筹码 BB 收益与终局筹码排名分数加权，旧 `chip-ev` 保持默认并兼容历史 checkpoint。课程 CLI 支持显式效用模式/排名权重，checkpoint 记录目标 provenance；测试覆盖零和性、确定性、参数校验和运行时编译。首个 6 人小模型发布 7,960 个节点，真实 Engine 命中 52 次但 action-value 完整数为 0，优势门将有效权重保持为 0。

V114 将每分片训练量提高 10 倍，20/32 个命中具备完整 action-value、8 个通过优势门，但全部为低权重 strategic 回退，未产生实际动作变化。V115 加入与真实初始栈一致的 150BB 课程，仍只有 strategic 命中。V116 聚焦 150BB 并提高到每分片 2,000 次 MCCFR，得到约 94 万原始精确访问和 31,091 个发布节点；120 个命中全部 action-value 完整，但仅 4 个通过，平均动作优势 LCB `-27.46`，仍为 0 次变化。继续堆同目标样本已无意义。

V117 新增 `phase-aware-tournament`：第 1 轮排名权重为 0，随后线性增加到设定上限，使早期以筹码 EV 为主、后期逐步重视名次。相同深度训练得到约 89 万原始访问和 29,248 个节点；59 个真实命中中 55 个证据完整、0 个通过优势门，平均 LCB `-23.25`。固定或阶段感知的单手排名代理都未能超过 QYZ，因此不继续在失败诊断集上搜索权重。

当前上线结论：生产 `qyz` 未被替换，V109–V117 没有任何版本通过 0.5% 动作物质性、全新 8-seed 6/9 人双桌 rank+HP 正下界、技能开启、延迟和运行时安全全部门槛，也不得宣称达到世界顶级职业牌手水平。下一代策略不能继续依赖单手抽象或局部 option；需要以完整 12 手赛事状态训练多手自博弈策略/价值网络，再蒸馏为毫秒级策略头，并使用冻结训练、校准、测试来源完成双桌正式验证。

## V118–V119：完整赛事轨迹策略与全局风格验证（2026-07-14）

V118 将训练单位从单手/单节点升级为完整 12 手赛事。采集器以 HMAC 隔离原始 seed namespace，完整轮换并镜像 6/9 人桌，只保存公开信息集、合法动作、实际动作和终局标准化名次/HP；训练器先在每个 seed group 内聚合，再把 group 作为独立统计单位，输出始终标记为 `offline-evaluation-only` 的毫秒级分层动作价值头。首批冻结训练集包含 120 场完整比赛、13,251 个决策、8 个桌型隔离 group 和 11 种合法动作 mask；采集隐私审计、确定性、模型校验、合法回退及策略注册测试均通过。

V118 全新 2-seed 6 人桌影子赛完成 48/48 场、657 个候选决策，但 0 次介入：608 个状态缺少跨独立 group 的动作支持，49 个命中特征却缺可靠替代动作。候选与 QYZ 的 rank/HP 完全相同，物质性门失败。该结果不是负收益证明，而是说明由确定性风格机器人产生的观察轨迹无法辨识同一状态下的反事实动作价值；不得通过降低 `minGroups` 或置信系数制造覆盖。

训练轨迹的比赛级聚合曾显示 `qyz-loose` 在 6/9 人桌的标准化名次均值领先当前 QYZ，因此 V119 把全程 Loose 作为全局策略候选，用未参与训练的新 seed 检查“整段后续策略共同变化”是否可复制。6 人桌 4-seed、96 场交叉/轮换/镜像筛选得到 rank 优势 `-0.0729 [-0.2500,+0.1042]`、HP 优势 `-116.45 [-520.80,+154.17]`，训练优势未外推，候选被否决且不再消耗 9 人桌正式预算。

当前上线结论：V118/V119 均未替换生产 `qyz`，也尚不能宣称机器人达到顶级职业牌手水平。下一阶段应使用带已知行为概率的随机探索或完整策略级反事实重放生成可辨识数据，并训练能跨多步分配终局收益的序列策略；在新候选通过独立 4-seed 筛选前不进入 8-seed 双桌、技能开启、延迟和运行时安全正式门。

## V120–V123：propensity 探索、联合效用与强制分支审计（2026-07-14）

V120 新增 40% 有界 epsilon 探索：60% 保留 QYZ 动作，40% 在除主动 all-in 外的合法动作上均匀采样，并记录精确行为概率和支持动作集合。原始均匀 all-in 探索在第 13 场产生合法提前终局，完整轨迹保护门正确拒绝部分数据；有界版随后完成 120 场、16,075 个决策，实际探索率 40.73%，propensity/合法动作公式零错误且不持久化底牌、座位、entryId 或原始 seed。训练器新增组内自归一化 IPS、有效样本数、6/9 桌型硬分区和分层公共状态回退。

4 个独立训练 group 的首版 V120 在 657–731 个新决策中仍为 0 次介入。扩展到 6 人桌 12 个独立 group、共 26,599 条合并轨迹，并把运行门提高到至少 6 group/24 有效样本后，纯 95% 节点 LCB 仍为 0 次变化。加入更粗但保留街道、行动人数结构、位置和赛事阶段的回退后，有 164 个状态完成比较但无正 LCB，证明瓶颈从动作可辨识性转为终局信用分配和估计方差。

V121 用标准化终局 rank/HP 等权效用作为高召回候选目标，保留至少 6 group、24 有效样本和 0.02 均值优势，最终联赛仍要求 rank/HP 分别过 95% 双下界。2-seed 中覆盖 94/834=11.27%，HP `+66.25`，但 rank `-0.25`；主要伤害来自 52 次把 QYZ fold 改为 call/raise，版本否决。

V122 改为纯终局名次目标并禁止覆盖基础 fold。2-seed 覆盖 13/771=1.69%，rank/HP 均值 `+0.0417/+6.35`；冻结 4-seed 筛选未复制，覆盖 19/1,426=1.33%，rank `-0.0625 [-0.125,0]`、HP `-4.95 [-63.28,+69.06]`。随后用同牌序强制分支审计 9 个实际介入：`check→feint/strike` 与 `feint→call` 双负，`strike→feint` 在该审计集双正。V123 只白名单 `strike→feint`，全新 2-seed 覆盖 4/742=0.539%，rank 持平但 HP `-2.5 [-5,0]`，再次否决。

当前上线结论：V120–V123 均保持 offline-only，生产 `qyz` 未替换。已知 propensity 解决了确定性行为混杂并产生了实质覆盖，但把同一终局收益复制给每个单步决策仍不能稳定分配多步信用。下一阶段必须训练显式序列/option 价值，或使用策略级反事实而非继续搜索单动作阈值；正式上线硬门保持不变。

## V124–V128：双步序列策略与真实 Engine option 反事实（2026-07-14）

V124 为每个玩家生成 HMAC 匿名 trajectoryId 和单调决策序号，将同一玩家、同一手牌的相邻两次决策组成 option。训练使用两步联合 propensity、最大 64 的重要性权重裁剪、桌型隔离和独立 group 统计；运行时只保存一次同手续行，下一次动作不再合法时自动回退 QYZ。6 人桌 12-group 数据包含 15,498 个决策、864 条玩家赛事轨迹和 6,073 个双步样本。联合 rank/HP 目标无正向安全介入；纯 rank 的 V125 只有 `feint→call→fold` 通过模型，但被初始风险门拦截。

V126 仅放开第二步止损 fold，继续禁止首动作 fold、任何 all-in 和覆盖基础 fold。2-seed 覆盖 2.82%，rank `+0.2292 [最低 +0.0833]`、HP `+110.83 [最低 -9.17]`；冻结 4-seed 覆盖 3.36%，均值仍为 rank `+0.3021`、HP `+264.17`，但 95% 下界分别降到 `-0.1875/-56.04`，因跨 seed 方差否决。

V127 新增按首动作估计的同手下一决策到达率，要求至少 6 group、24 有效双步样本且到达率至少 70%。2-seed 的 HP 下界首次严格为正：覆盖 2.37%，rank `+0.2083 [0,+0.4167]`、HP `+133.02 [+21.25,+244.79]`；全新 4-seed 未复制，覆盖 2.66%，rank `-0.0417 [-0.2083,+0.0625]`、HP `+6.30 [-147.66,+163.23]`，否决。

V128 扩展真实 Engine 重放接口，可在相同牌序/座位/QYZ 后续策略中强制 option 首动作，并只在同一玩家同一手的下一次行动可达且合法时强制续行动作。该接口有确定性、相同信息集和双步顺序回归测试。首批 6-cluster 直接因果审计得到 11 条分支：主 option `feint→call→fold` 10 条、5 cluster、续行到达 6/10，平均 rank `-0.1`、HP `+61.5`，HP 范围 `[-2700,+3140]`，直接解释了联赛高均值但不稳定。高召回提案库的 8-cluster 审计只新增 3 条：唯一双正的 `fierce→strike→fold` 为单一特定上下文、1 cluster，证据不足，不注册运行候选。

当前上线结论：V124–V128 全部保持 offline-only，生产 `qyz` 未替换。双步执行本身已可靠，但观察序列价值仍不能替代真实 option 反事实；下一阶段应针对稀有双正上下文做定向多 cluster 强制序列采集，或扩大到整手策略反事实。没有至少 4 个独立直接因果 cluster 和全新联赛双下界前，不得把单样本规则加入生产。

## V129–V133：高覆盖序列/单动作独立因果确认（2026-07-14）

V129 为强制序列采集器增加可审计的目标签名、目标集合和 seed offset。针对 V128 唯一双正样本的完整翻前上下文，在 32 个独立 cluster、384 场完整轮换/镜像基线中命中 0 次，证明该规则覆盖过稀，不能形成可部署策略。该样本不注册，也不通过扩大相同假设的轮数追逐偶然结果。

V130 新增同手续行机会普查，只统计 QYZ 在同一手牌内确实还有下一次决策的节点，并按 global/contextual/tactical 三层聚合合法非 fold/all-in 替代动作。6 人桌 8-cluster、96 场基线得到 1,602 个目标决策、548 个同手续行对和 1,925 个候选签名。使用完全不同 namespace 的 8-cluster 直接因果集回放三个覆盖 6–7 个发现 cluster 的高频 `激进动作→check→fold` 候选，共 42 个分支：两条规则 rank/HP 均值明确为负；唯一接近门槛的 flop/heads-up/无压力/L2 `feint→check→fold` 在发现集 7 cluster 的 rank/HP 为 `+0.417/+419.9`，但双侧 95% 下界为 `-0.012/-29.4`。

V131 没有通过位置或牌力切分缩小样本来制造正结果，而是使用全新 group 9–16 单独确认该候选。确认集命中 10 次、7 cluster，rank `+0.0476`、HP `-181.2`，下界 `-0.832/-612.6`，候选否决。三个双步候选的第二步实际到达率仅 0–13.3%，说明在这些局面中主要效果来自首动作，继续增加状态机复杂度没有依据。

V132 因此回到单动作直接因果验证，但只测试机会普查中高覆盖、尚未被历史审计否决的六个非极端替换，仍禁止主动 fold/all-in。目标集合预检发现“同一状态至少一个动作合法”不足以保证集合中每个动作合法；Engine 正确拒绝了分支，采集器随后改为逐动作合法校验并重跑，未保留失败运行数据。正式 8-cluster 产生 61 个分支；五条规则被否决，唯一接近门槛的 turn/heads-up/无压力/L1 `strike→fierce` 在 4 cluster 的 rank/HP 为 `+0.25/+71.25`，下界 `-0.0216/-12.25`。

V133 使用全新 group 9–16 独立确认 `strike→fierce`。确认集 16 次、5 cluster，rank `+0.0667`、HP `+41.73`，但下界 `-0.246/-284.19`，仍未复制，候选否决。V129–V133 没有生成或注册新的运行时策略；新增的机会普查、定向/集合强制回放、逐动作合法校验和 cluster 等权小样本分析均只服务离线研究。

当前上线结论：生产 `qyz` 仍未替换，机器人尚未满足上线标准。局部单节点与相邻两步策略已在独立确认中反复显示高方差或不可复现；下一阶段转向整手或完整 12 手赛事的策略级反事实/自博弈，让后续策略整体随首动作共同变化。任何候选仍必须依次通过独立 4-seed 6 人桌筛选、全新 8-seed 6/9 人桌 rank+HP 95% 双下界、技能开启、延迟、合法动作与运行时安全硬门，才允许替换生产 `qyz`。

## V134–V139：整手冻结风格与策略级反事实（2026-07-14）

V134–V136 首次把策略变化冻结到完整一手：每手第一次行动只根据公开存活筹码比选择风格，手内后续所有决策保持同一风格，下一手重新选择。三条预注册离线候选分别为短码施压、短码激进/深码收紧和残局生存。6 人桌 2-seed、48 场完整交叉/轮换/镜像初筛中，V134 rank `+0.0208 [0,+0.0417]` 但 HP `-23.13 [-40.83,-5.42]`；V135 rank 同为 `+0.0208` 但 HP `-116.98`；V136 rank `-0.0625`、HP `-29.79`。三者全部在初筛否决，不进入 4-seed。

V137 为联赛增加 `forcedHandStyle`：指定目标玩家、回合和已知风格后，该风格在目标整手的每次决策临时生效，手外立即恢复；它与单动作/双步强制模式互斥，技能关闭，并在决策 trace 中显式标记。回归测试覆盖目标手全程生效与手外恢复。新采集器在相同发牌、座位和冻结 QYZ 后续策略上，分别重放 aggressive/tight 整手续策，4 个独立 cluster 共 48 场基线和 96 个分支。

V137 初版分析暴露出物质性漏洞：风格被调用但动作完全相同时，全零 rank/HP 会被“非负下界”误标为训练通过。该结果没有注册或进入联赛。V138 在每个分支保留目标手基线/分支动作序列，要求至少 4 次真实动作变化且 rank/HP 95% 下界严格为正；相同 seed 确定性重采后，aggressive 和 tight 各只改变 2/48 手，没有任何 `赛事压力+风险档` 或 `风险档+筹码档` 分组通过。

V139 使用全新 namespace 测试差异更大的 loose/bluffer 整手风格。Loose 改变 4/48 手，全局 rank/HP 均值 `-0.0208/-1.77`；Bluffer 改变 3/48 手，均值 `-0.0417/-6.77`。所有预先指定低维分组均未通过真实变化数和双指标下界。现有 `AI_STYLES` 对 QYZ 只是轻量参数修饰，不能提供足够的策略表达能力；继续搜索风格阈值不会进入 4-seed。

当前上线结论：V134–V139 全部为 offline-only，生产 `qyz` 未替换，仍不能确认上线。局部规则、相邻两步 option 和现有整手风格参数三条路线均已被独立实验否决或证明覆盖不足。下一训练阶段需要使用可独立学习的整手/赛事策略网络或显式动作分布（而不是现有风格组合），用探索 propensity 或策略级随机化获得可辨识收益，再按既定 4-seed、8-seed 双桌、技能、延迟、合法性和运行时安全门验证。

## V140–V145：双目标线性模型、成对 IPS 与独立数据扩充（2026-07-14）

V140 新增按 `sourceGroup` 独立拟合的 256 维哈希线性终局收益模型，以轨迹归一化、裁剪 IPS 同时估计 rank/HP 动作价值，并在运行时要求两个目标的组级 95% 下界同时为正。12 组、15,498 条 6 人桌记录的训练分布覆盖为 3.26%；全新 2-seed 初筛实际改变 4.3%，但 rank `-0.0625 [-0.208,+0.083]`、HP `-48.3 [-161,+64.4]`，否决。

V141 把 212 条真实 Engine 强制分支训练出的局部因果伤害门叠加到 V140。2-seed 初筛一度得到 rank `0 [-0.0417,+0.0417]`、HP `+136.5 [+120.8,+152.1]`；冻结后进入全新 4-seed，3.5% 动作变化下 rank `-0.0729 [-0.146,+0.0104]`、HP `-53.9 [-172.1,+50.4]`，未复制。V142 仅保留 flop 后双均值为正但只改变 0.6%，低于 1% 物质性门；V143 扩到 flop/turn 后 rank/HP 转负。三者均否决。

V144 改用已知 epsilon/support 的 centered pairwise IPS，直接估计 `Q(替代动作)-Q(QYZ 动作)`，继续保护基础/候选 fold 与 all-in。12 组模型在 2-seed 中改变 1.1%，rank/HP 均值为 `+0.0417/+36.7`；全新 4-seed 只改变 0.5%，rank `+0.0417 [-0.0208,+0.125]`、HP `+47.3 [-47.1,+141.8]`，下界与物质性均失败。

V145 新采 12 个互不重叠的 6 人桌探索组，与旧 12 组组成 30,835 条记录。多 provenance 合并必须显式开启，默认仍拒绝不同密钥/namespace；union 强制所有 `sourceGroup` 不重叠并保存组合哈希及来源数组。模型最小动作对支持从 8 组提高到 16 组。训练分布仅接受 154/30,835（0.499%）；全新 2-seed、48 场初筛中 785 次候选决策零动作变化，rank/HP 与 QYZ 完全相同，否决且不进入 4-seed。

## V146–V147：组删除 jackknife 与 48 组停止规则（2026-07-14）

V146 将高噪声的“每组各训一个模型”重构为“全部支持组拟合 + 每次删除一个独立组重拟合”。运行时用 cluster delete-one jackknife 标准误计算 rank/HP 双下界，不降低 16-group 支持门。确定性、合法动作保护、正效应与 provenance 回归测试通过；但 24 组模型在训练分布只接受 25/30,835（0.081%），低于物质性前置门，直接否决。

V147 再采 24 个全新组、288 场、31,701 条决策。三批合并后共 48 个互不重叠组、62,536 条决策；训练使用 24,312 条有效 IPS 记录并把最小支持同步提高到 32 组。样本翻倍后保守接受数反而收缩到 4/62,536（0.0064%），说明当前单步终局信用分配没有可复制的正效应，而不是简单缺少轮数。按停止规则不再沿相同估计器堆数据，也不消耗独立联赛预算。

当前上线结论：V140–V147 全部保持 offline-only，生产 `qyz` 未替换。至今没有候选通过独立 4-seed 6 人桌筛选，更没有资格进入 8-seed 6/9 人桌、技能、延迟和运行时安全正式门。下一阶段必须改造基础策略本身，转向可处理多手长期回报的自博弈策略表示/价值近似；不能放宽 1% 动作物质性、rank+HP 双下界或来源独立性来制造“上线”。

## V148–V156：完整赛事进化、稳健 seed 选择与多轴分类策略（2026-07-14）

V148 新增长度为 12 的公开状态特征和完整 12 手赛事 CEM 进化器。零权重严格复现 QYZ，候选只能在真实 Engine 合法动作中沿风险轴移动。V148 独立 2-seed 的 rank 均值为 `+0.25`，但 HP 为 `-92`；V149 经固定校准后在 2-seed 得到 rank/HP `+0.0625/+28.19`，冻结 4-seed 却反转为 `+0.0104/-78.85`。V150 修复候选并发训练造成的收益归因混杂，改为逐候选与 QYZ 槽位交叉；独立 2-seed 为 `-0.35/-410.5`。V151 对 V149/V150 做 15 组多 seed 收缩混合，独立 2-seed 仍为 `0/-42.81`。四版全部否决。

V152 把训练和代际校准都改为至少三个独立 seed group，并用均值减 `0.75×SE` 的 rank/HP 双稳健分数选择。训练 360 场后，独立 2-seed 为 rank/HP `+0.0625/+107.3`、动作变化 18.1%，因此冻结进入 4-seed；正式筛选 96 场结果为 rank `-0.1458 [-0.3125,+0.1146]`、HP `-102.55 [-241.35,+123.07]`、变化率 21.86%，明确否决且不进入 9 人桌。

V153 为风险轴加入向后兼容的绝对位移死区，并在四个全新 seed 上预注册 16 组“权重缩放×死区”。所有物质性合格组合的 rank/HP 均值至少一项为负；唯一双均值非负组合变化率只有 0.749%，低于 1%。V153 在校准阶段停止。

V154 将单一风险轴重构为 36 参数的因子化分类策略，分别学习风险、继续范围和主动权，零权重仍精确复现 QYZ。420 场训练中，多数种群改变 22%–36% 的决策并为负；分布中心一度双正但变化率只有约 0.88%，训练内门未通过。V155 把每代两个精英个体也送入固定独立校准，540 场后冻结一个校准 rank/HP `+0.333/+0.302`、变化率 7.87% 的精英；全新 2-seed 立即反转为 rank `-0.2292 [-0.4167,-0.0417]`、HP `-193.23 [-206.67,-179.79]`、变化率 4.24%，否决。

V156 增加第三层嵌套来源隔离：训练 seed 只产生种群，四个固定 calibration seed 只形成最多五个候选的短名单，全部代结束后再用六个从未参与训练/校准的 final-selection seed 重评。600 场完成后，五个短名单候选的 rank/HP 均值全部为负；最佳物质性候选仍为 `-0.10/-0.1309`，变化率 6.58%。嵌套门成功在正式联赛前识别并拒绝 V155 型选择偏差。

当前上线结论：V148–V156 全部为 offline-only，生产 `qyz` 没有切换。风险轴、死区收缩和低秩多轴分类器都未通过独立 4-seed 6 人桌门；因此没有运行 9 人桌、8-seed 双桌、技能开启或延迟正式门，也不能宣称达到世界顶级职业牌手水平。下一阶段不再从小型候选池中按少量 seed 挑最大值，应采用更大规模的真实自博弈 actor-critic/策略梯度训练、独立的周期性 checkpoint 选择和一次性冻结测试；所有既有硬门保持不变。

## V157–V158：带 propensity 的赛事策略梯度与公开状态 critic（2026-07-14）

V157 为因子化分类策略增加训练专用 softmax 探索器。每个真实 Engine 决策都记录所选动作、完整合法支持集和精确 behavior probability；不持久化底牌、原始 seed 或 entryId。批量 REINFORCE 使用同局候选相对 QYZ 的标准化 rank/HP 终局回报，先求 batch 平均梯度再裁剪，并以独立 validation/final-selection seed 选择冻结 checkpoint。392 场训练选中第 2 代：final-selection rank/归一化 HP `+0.0333/+0.0522`、变化率 7.69%。全新 2-seed 冒烟为 rank `+0.2083 [+0.0833,+0.3333]`、HP `+217.1 [-167.4,+601.7]`、变化率 8.2%，达到进入 4-seed 的预设条件；冻结 4-seed 96 场却反转为 rank `-0.1875 [-0.5729,+0.1563]`、HP `-303.1 [-458.9,-147.4]`、变化率 6.3%，明确否决。

V158 在相同公开特征上增加训练专用线性 critic，以 `终局回报−状态价值` 替代 batch 全局基线，并把每个 checkpoint 的 validation 增至 6 seed、final-selection 增至 8 seed。544 场后，三个 final-selection checkpoint 均未双正：最佳物质性 checkpoint 为 rank/归一化 HP `-0.025/-0.0188`、变化率 4.87%；另一个 checkpoint 虽 rank `+0.025`，HP 为 `-0.0810`。V158 在训练内停止，未注册运行时候选。

当前上线结论：V157/V158 均保持 offline-only，生产 `qyz` 未替换。策略级随机探索和 actor-critic 管线已能端到端训练、审计与来源隔离，但 36 参数 actor 和 12 参数线性 critic 的表示能力仍不足。下一阶段需要非线性 value/actor 网络、更多赛事状态记忆和数量级更大的自博弈样本；新模型仍须从独立 4-seed 6 人桌开始，不能复用 V157 的正向 2-seed 或降低双下界门槛。
