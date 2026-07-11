# qyj-online · 群英决

> 英雄对决表现 × 德州扑克竞技内核 · 自托管网页版（单机人机对战 + 联机组队对战）

**群英决**是一款以历史英雄对决为表现形式、以德州扑克为竞技内核的快节奏策略卡牌游戏。
玩家扮演诸葛亮、项羽等历史英雄，手握两枚暗藏的杀招令（底牌），随天时、地利、人和
（公共牌）逐步揭示战局，通过灌注气血（下注）向对手施压，以杀招（牌型）定胜负。
界面与交互参考经典国风卡牌游戏的武将牌美学，底层完整保留德州扑克久经验证的博弈规则。

- **原生双入口**：纯 HTML/CSS/ES Modules，无运行时框架；PC 与 H5 分开启动、共享会话和规则层
- **平台隔离**：`index.html` 始终为 PC，`h5.html` 始终为手机横屏，不按视口自动串页
- **零信任**：联机采用权威服务器架构，暗牌只私发本人，从协议层杜绝透视外挂
- **零外部依赖**：唯一的运行时依赖是对战服的 `ws`（WebSocket 库）
- **玩家数据持久化**：昵称、纹章、累计战绩、最近对局和公开行动扑克统计由服务端 SQLite 保存，浏览器仅保留设备凭据与缓存
- **单机/联机共用一套逻辑**：`js/game/` 纯逻辑层同时驱动浏览器单机与 Node 对战服

---

## 目录

- [玩法介绍](#玩法介绍)
- [技术架构](#技术架构)
- [本地运行](#本地运行)
- [云主机部署](#云主机部署nginx--systemd)
- [测试](#测试)
- [二次开发指南](#二次开发指南)
- [常见问题](#常见问题)
- [版权说明](#版权说明)

---

## 玩法介绍

### 对局框架

| 项目 | 规则 |
|---|---|
| 人数 / 时长 | 6 人局（真人 + AI 补位），固定 12 回合，单局约 8~12 分钟 |
| 初始资源 | 气血 1500（筹码）、能量 2⚡（技能资源） |
| 血祭（盲注） | 每 3 回合翻倍：10/20 → 20/40 → 40/80 → 80/160 |
| 胜负 | 气血归零当场阵亡；12 回合打满按剩余气血排名 |

### 德州内核 · 世界观包装对照

| 德州扑克 | 群英决 |
|---|---|
| 底牌（2张） | 杀招令（2枚暗牌） |
| 公共牌（5张） | 天机五道：天时×3 / 地利 / 人和 |
| 下注 / 加注 | 灌注：佯攻⅓池 · 强攻½池 · 猛攻⅔池 |
| 全下 | 决死（专属台词演出） |
| 弃牌 / 过牌 / 跟注 | 退避 / 静观 / 应战 |
| 底池（含边池） | 血池（完整支持决死边池与平分） |
| 牌型十阶 | 杀招十品：孤锋独行(高牌) → 九五至尊(皇家同花顺) |

牌面直接使用扑克原生符号（♠♥♦♣ + 2~10/J/Q/K/A），会打牌即会上桌；
内置蒙特卡洛**实时胜算条**与**当前杀招提示**，新手友好。

### 与经典无限注德州的边界

- 发牌、四轮行动、牌型比较、全下、平分、未跟注筹码返还及主池/多级边池按经典德州结算。
- 单挑时按钮位下小盲并在翻牌前先行动；不足完整加注额的全下不会错误重开加注权。
- 为适配快节奏界面，下注采用 1/3、1/2、2/3 池三个合法预设与全下，而不是任意数额输入。
- 12 回合赛制、气血淘汰、能量和英雄技能属于本游戏规则，因此整体并非原样现金桌德州。
- 亮招时战报会逐项显示“主池 / 边池 1 / 边池 2”及各自赢家。
- 桌面中央常驻显示当前主池/边池；仅轮到真人操作时，临时显示上次主动下注前的血池、下注金额及占池比例。
- 轮到真人操作时会生成只读的 GTO 近似建议：结合位置、有效筹码、SPR、底池赔率、多人池风险、牌面结构与听牌，给出主建议、备选频率、把握度、理由及定量指标；PC/H5 共用“AI辅助”偏好，且建议模块不会自动执行行动。
- 结算飘字只显示净收益：总奖金扣除本人投入；边池战报仅扣除本人在该边池的投入。
- H5 在翻牌、转牌和河牌阶段仅对使用本人暗牌形成的牌型升级提示“中牌”，同步高亮组成牌；每手按总净收益显示胜、负或平，整局结算明确显示胜利/失败、名次与前三标记。
- H5 亮牌结算集中展示所有未弃牌玩家的两张暗牌、武侠牌型名、标准德州类型、获池毛额和整手净输赢；主池、边池与平分均使用服务端权威结果。
- H5 每个座位持续显示“尚未行动、等待他人、轮到行动、已操作、待响应、已退避、决死、阵亡”；已操作和待响应会携带具体操作与数值，退避/决死跨下注街保留，联机重连从权威快照恢复。
- 有人在决死且所有后续下注行动已经封闭时，立即公开全部在局底牌，再自动发完公共牌。

### AI 策略

AI 使用不读取暗牌的 GTO-inspired 决策层：翻前位置范围、有效筹码与短码推/弃，翻后多人胜率、
底池赔率、SPR、牌面湿度、听牌与阻断牌，以及按牌力混合的下注/过牌/诈唬频率。它不是针对
英雄技能和三档下注抽象离线求解的完整 CFR 纳什策略；真正的六人桌 GTO 仍需专用求解器与策略表。

### 十六英雄技能

每位英雄一个主动技（以两枚暗牌为发动条件，每回合限一次）+ 一个被动技：

| 英雄 | 类型 | 主动技 | 被动技 |
|---|---|---|---|
| 诸葛亮 | 天机 | 观天 2⚡：窥探下一张尚未揭示的天机牌 | 【同契】两令同花色 +1⚡ |
| 貂蝉 | 洞察 | 魅惑 3⚡：随机窥视一名对手的一枚暗令 | 【闭月】亮招获胜 +1⚡ |
| 韩信 | 谋攻 | 背水列阵 1⚡：保持在局至下一阶段获得 2⚡ | 【多益】两令不成对且不同花色 +1⚡ |
| 项羽 | 威慑 | 威震 1⚡：本回合若兵不血刃夺池返还 1⚡ | 【霸王】不亮招夺池 +1⚡ |
| 吕不韦 | 经营 | 奇货可居 1⚡：预测本回合是否亮招，猜中获得 2⚡ | 【商道】本回合气血净增长 +1⚡ |
| 廉颇 | 防守 | 坚壁 2⚡：亮招落败返还投入的 10%，最多 50 | 【老练】亮招落败 +1⚡ |
| 武则天 | 制衡 | 临朝 2⚡：令目标下一次主动技能费用 +1⚡ | 【天授】首次成为技能目标 +1⚡ |
| 花木兰 | 变阵 | 易装 1⚡：公开一枚暗令并返还 1⚡ | 【归甲】公开暗令未进入最佳五张牌 +1⚡ |
| 西施 | 观心 | 浣纱 1⚡：预测目标下一次行动 | 【沉鱼】行动预测成功的回合 +1⚡ |
| 王昭君 | 止戈 | 出塞 1⚡：预测下一张公共牌颜色 | 【和鸣】无人加注的阶段结束时 +1⚡ |
| 上官婉儿 | 文心 | 观辞 2⚡：查看目标当前胜率区间 | 【落笔】自己的牌型品阶首次变化 +1⚡ |
| 李清照 | 词韵 | 寻词 1⚡：预测自己最终牌型区间 | 【漱玉】未主动加注并参与亮招 +1⚡ |
| 妇好 | 卜战 | 贞卜 1⚡：声明自己下一次行动姿态 | 【征伐】多人仍在局时首次进攻 +1⚡ |
| 穆桂英 | 帅阵 | 挂帅 2⚡：当前阶段免疫指向技能 | 【破阵】决死后参与亮招并存活 +1⚡ |
| 女娲 | 造化 | 造化 2⚡：本回合复制一项可复制被动 | 【补天】复制被动未触发时返还 1⚡ |
| 嫦娥 | 月鉴 | 望月 1⚡：查看下一张公共牌花色 | 【清辉】新公共牌与暗令同花色 +1⚡ |

技能采用声明式注册表和统一事件解释器，只允许信息、预测、能量与小额保险效果；
不得修改暗令、公共牌、牌堆、牌型、下注选择或血池分配。

### 联机组队

- 队伍最多 **3 名真人**，进队随机赐名（战国风代号，可随时改名）
- 房主随时可开始；选将阶段**英雄不可重复**（先选先得、可换选、60 秒超时随机分配）
- 不足 6 人由 AI 自动补位（5 种性格：激进/紧手/诈唬/紧凶/松浪，英雄不重复）
- 行动限时 30 秒（可消耗 1⚡ 延长 30 秒），超时与断线自动托管
- 短时断线默认保留会话 90 秒：恢复原队伍、房主身份、选将、战斗座位、本人暗牌或未确认的结算页；超时后才清退并转移房主

### 玩家扑克统计

- 大厅与房间可打开玩家统计；PC 对局鼠标悬停/聚焦头像显示迷你 HUD，点击查看详情，H5 点击武将立牌打开抽屉。
- 核心指标为 `VPIP / PFR / 3Bet / AF / Hands`，详情补充 `WTSD / W$SD / CBet / Fold CBet`。
- 默认统计范围为**近 30 天、最多最近 200 手**；0、1–29、30–99、100 手以上分别显示无、低、中、高可信度。
- 服务端只把公开下注行动转换为逐手计数，不保存暗牌或牌力；统计只描述历史频率，不向当前行动输出自动建议。
- 完整公式、分母和产品边界见 [`docs/poker-player-stats-design.md`](docs/poker-player-stats-design.md)。

---

## 技术架构

```
┌─────────────────────────┐        ┌─────────────────────────────┐
│  浏览器（前端，静态托管）  │        │  Node 对战服 server/server.mjs │
│                         │  WSS   │                             │
│  js/ui   界面层(DOM/CSS) │◄──────►│  权威引擎（复用 js/game）      │
│  js/net  RemoteEngine   │  JSON  │  组队大厅/选将裁决/AI补位      │
│  js/game 逻辑层 ─────────┼────────┼─► 同一套代码，两端共用         │
└─────────────────────────┘        └─────────────────────────────┘
```

- **逻辑层**（`js/game/`）：数值表、牌组、7选5牌型评估、蒙特卡洛胜率、
  十六英雄技能、AI 决策、回合状态机（下注轮/主池边池/技能/演出节奏），零 DOM/零 Node API
- **技能框架**（`js/game/skills.js`）：统一技能定义、发动条件、标准效果操作码、
  延迟状态与被动事件；人物清单只引用技能 ID 和表现预设
- **单机模式**：浏览器内直接实例化引擎
- **联机模式**：服务器实例化引擎（权威），客户端 `RemoteEngine` 镜像公开状态快照并转发操作；
  对局界面 `battle.js` 对两种引擎完全无感
- **协议**：WebSocket + JSON。客户端→服务器为 `{cmd:...}` 命令
  （resume/create/join/leave/rename/startPick/pick/startGame/act/skill/extend/…），
  服务器→客户端为 `{ev:..., a:载荷, s:公开快照}` 事件流；
  **暗牌通过 `hole` 事件只私发给持有者本人**
- **会话恢复**：加密随机恢复凭证只存于 `sessionStorage`，通过 WebSocket 首条消息提交，不进入 URL 或日志；恢复成功立即轮换，旧凭证失效
- **玩家数据**：`server/player-store.mjs` 使用 Node 内置 SQLite；schema v2 将赛果和逐手公开行动统计放在同一事务中写入，并以比赛、回合、玩家联合唯一键保证幂等

```
qyj-online/
├── index.html          # PC 独立入口
├── h5.html             # H5 独立入口（仅横屏）
├── package.json        # web / build / server / unit / e2e 命令
├── css/
│   ├── style.css       # 共享与既有 PC 对局样式
│   ├── pc/             # PC 大厅、玩家系统、房间样式
│   └── h5/             # H5 横屏专用布局与安全区样式
├── assets/             # 源资源；runtime-manifest.json 是上线资源白名单
│   └── h5/             # 手机端 WebP 尺寸变体
├── js/
│   ├── game/           # 纯逻辑层（两端共用）
│   ├── entry/          # pc.js / h5.js 平台启动器
│   ├── net/            # 协议、WebSocket 与 RemoteEngine
│   ├── session/        # 单机/联机统一会话边界
│   ├── services/       # 玩家档案、资源变体等跨页面服务
│   └── ui/             # 共享、PC、H5 三层界面实现
├── scripts/            # H5 资源生成、静态发布白名单构建、开发服务器
├── server/             # Node WebSocket 权威对战服（独立 package.json，依赖 ws）
├── test/               # 规则、资源、服务端与真实浏览器全流程测试
└── dist/public/        # npm run build:static 生成；唯一推荐的静态发布根目录
```

---

## 本地运行

**环境要求**：Node.js ≥ 24（服务端使用内置 `node:sqlite`）。前端静态服务可用 Node 或 Python 任选。

```bash
git clone https://github.com/wade004/qyj-online.git
cd qyj-online
npm install          # 安装对战服依赖（ws）

# 终端 1：前端静态服务
npm run web          # → http://localhost:8080
# 没有 npx 环境也可以：python -m http.server 8080

# 终端 2：对战服务（只玩单机可跳过）
npm run server       # → ws://localhost:8790
```

对战服首次启动会自动创建 `server/data/qyj.sqlite`。玩家设备标识仅以 SHA-256 指纹入库；
稳定玩家编号、昵称、纹章、对局/胜场/前三/最佳名次、最近 10 场战绩及近 30 天/最近 200 手扑克统计以 SQLite 为权威来源。
测试可通过 `startServer(port, { databasePath: ':memory:' })` 使用隔离内存库。

`npm run web` 仅用于源码目录开发。上线前必须执行白名单构建并从构建目录验收：

```bash
npm run test:assets   # 校验资源存在性、音效键与真实编码
npm run build:static  # 输出 dist/public
npm run web:dist      # 只托管上线白名单，→ http://localhost:8080
```

仅在原始立绘或背景更新时需要重新生成 H5 WebP：先安装 Python 3 与 Pillow，
再执行 `npm run build:h5-assets`；常规发布直接使用已生成并纳入版本管理的变体。

构建只复制 `index.html`、`h5.html` 的 CSS/JS 依赖和 `assets/runtime-manifest.json` 中登记的资源；
`server/`、`test/`、`docs/`、`logs/`、参考素材及其他源文件不会进入静态发布目录。

浏览器按平台打开：

- **PC**：`http://localhost:8080/index.html`，宽屏或窄屏都保持 PC 交互
- **手机 H5**：`http://localhost:8080/h5.html`，进入后要求横屏；竖屏仅显示阻断层，游戏内容不可操作
- H5 手牌与公共牌使用由 PC 点数武器牌面生成的轻量 WebP 变体和花色素材；未揭示牌使用鎏金龙纹牌背，并保留阶段标签。
- 两个入口都完整支持单机与联机；联机默认连接 `ws://<当前域名>:8790`

> 注意：ES Modules 要求 http(s) 协议加载，**直接双击 index.html（file://）无法运行**。

---

## 云主机部署（nginx + systemd）

以 Ubuntu/Debian 为例，假设部署到 `/var/www/qyj-online`、域名 `your-domain.com`。

### 1. 安装环境（服务器上）

```bash
sudo apt update && sudo apt install -y nginx nodejs npm
node -v   # 需要 ≥ 24，过旧可用 NodeSource 或 nvm 安装新版
```

### 2. 上传项目并安装依赖

```bash
# 本机执行
scp -r qyj-online/ user@your-host:/var/www/qyj-online
# 或在服务器上直接 git clone https://github.com/wade004/qyj-online.git

# 服务器执行：安装依赖、校验资源并生成静态发布目录
cd /var/www/qyj-online
npm install
npm run build:static
```

### 3. 对战服务常驻（systemd）

创建 `/etc/systemd/system/qyj-server.service`：

```ini
[Unit]
Description=QYJ Battle Server
After=network.target

[Service]
WorkingDirectory=/var/www/qyj-online/server
ExecStart=/usr/bin/node server.mjs 8790
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qyj-server
sudo systemctl status qyj-server   # 应显示 active (running)
```

### 4. nginx 站点（静态前端 + 同域 /ws WebSocket 反代）

创建 `/etc/nginx/sites-available/qyj-online` 并软链到 `sites-enabled/`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 只暴露白名单构建产物，禁止把仓库根目录作为 Web Root
    root /var/www/qyj-online/dist/public;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # 当前仍有固定文件名资源；完成全量内容哈希前不得使用 immutable
    location /assets/ {
        try_files $uri =404;
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    location ~ ^/(index|h5)\.html$ {
        add_header Cache-Control "no-cache";
    }

    # WebSocket 反代：同域 /ws → 对战服 8790（HTTPS 下自动升级为 WSS）
    location /ws {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    gzip on;
    gzip_types text/css application/javascript;
}
```

### 5. 前端指向同域反代

编辑源文件 `index.html` 和 `h5.html`，在 `<head>` 内各加一行（让联机走 `/ws` 反代而非直连 8790 端口），
然后重新执行 `npm run build:static`：

```html
<script>window.QYJ_WS_URL=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'</script>
```

### 6. 生效与 HTTPS

```bash
sudo nginx -t && sudo nginx -s reload
# HTTPS（推荐）：
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

访问 `https://your-domain.com` 即可游玩；防火墙只需放行 80/443
（8790 由 nginx 本机反代，无需对外开放）。

### 无域名 / 纯 IP 部署

跳过第 5、6 步（不设 `QYJ_WS_URL`），前端会默认直连 `ws://<IP>:8790`，
此时防火墙需额外放行 8790 端口。

---

## 测试

```bash
npm test
npm run test:server
npm run test:assets
npm run test:e2e
# 或一次完成全部校验
npm run test:all
```

Windows 默认复用本机 Edge；Linux/macOS 首次运行浏览器测试前执行
`npx playwright install chromium`。也可用 `PLAYWRIGHT_CHANNEL` 指定已安装的 Chrome/Edge 通道。

主要覆盖：

| 测试 | 覆盖 |
|---|---|
| `test/assets.mjs` | 运行时清单完整性、资源存在性、技能音效键、真实文件编码；已登记格式遗留给出警告，新增格式错配直接失败 |
| `test/poker_rules.mjs` | 主池/边池、未跟注返还、单挑盲注、短码全下重开规则及 AI 翻前范围 |
| `test/skills.mjs` | 32 个技能配置完整性、统一操作码、多字段输入、目标/预测/复制事件，以及扑克核心不可变约束 |
| `test/smoke.mjs` | 牌型评估 11 例自检（皇家同花顺~高牌+轮子顺）；6 局完整对局（12 回合完赛、血池不丢失、小额保险受控、无负血） |
| `test/mp_smoke.mjs` | 真实双 WebSocket 客户端端到端：建队/加入/改名(超长拒绝)/选将互斥/AI补位开局(英雄唯一)/打满出冠军/战后回房再开局/**对局中断线托管** |
| `server/test/server-security.test.mjs` | 非法消息、载荷上限、心跳、优雅关闭、断线清退与房主转移 |
| `server/test/resume.test.mjs` | 11 项服务端恢复/安全测试中的恢复覆盖：原座位与暗牌、令牌轮换、旧连接替换、离线开局阻断、过期清退、结算恢复与快速关服 |
| `server/test/player-store.test.mjs` | SQLite 建档、资料更新后重启持久化、战绩事务、幂等累计、最近战绩与输入安全校验 |
| `server/test/poker-stats.test.mjs` | SQLite v1→v2 迁移、HUD 公式与空分母、30 天/200 手窗口、可信度、逐手与赛果原子写入及重复结算幂等 |
| `server/test/player-protocol.test.mjs` | 玩家身份绑定、资料 ACK、双视角房间统计、隐私字段隔离，以及完整一局后跨服务重启恢复战绩与扑克统计 |
| `test/e2e/real-user-flow.spec.mjs` | Playwright 模拟真实用户：PC/H5 入口隔离、PC 三档小屏适配、H5 顶部声音与 568×320 操作可达、只读 GTO 开关/建议/不自动行动、玩家资料与统计交互、全员座位状态与操作金额、中牌特效、全员摊牌明细、单手净输赢、整局胜负名次，以及混合端断网恢复、结算并回房 |

---

## 二次开发指南

- **调数值**：公共数值集中在 `js/game/config.js`，技能费用和条件在 `js/game/skills.js`
- **加英雄**：在 `js/game/skills.js` 或拆分技能清单中配置主动/被动技能，在 `js/game/heroes.js` 引用两个技能 ID；
  不需要修改引擎。立绘放入 `assets/`，表现通过技能与人物的 `presentation` 字段选择预设；
  需要上线的资源还必须加入 `assets/runtime-manifest.json` 并通过 `npm run test:assets`
- **改界面主题**：共享兼容色板在 `css/style.css`；平台布局分别在 `css/pc/`、`css/h5/`
- **服务器容量**：单进程支持多队伍并行对局；队伍上限等常量在 `server/server.mjs` 头部
- **测试加速**：`startServer(port, { speed: 10 })` 可让演出节奏加速（仅测试用）

---

## 常见问题

**Q：打开页面白屏？**
A：必须通过 http(s) 访问（静态服务器），不能直接双击 index.html（file:// 下 ES Modules 被浏览器拦截）。

**Q：联机模式一直"正在连接决斗阵盘…"？**
A：对战服未启动或不可达。本地开发确认 `npm run server` 在跑；线上部署确认
`systemctl status qyj-server` 为 running、nginx `/ws` 反代已配置、且 `QYJ_WS_URL` 指向正确。

**Q：HTTPS 站点联机连不上？**
A：HTTPS 页面只能用 WSS。按部署第 4、5 步走同域 `/ws` 反代即可（certbot 签发后自动生效）。

**Q：可以只部署单机版吗？**
A：可以。只部署静态文件、不跑对战服即可，联机入口会提示服务器不在线。

---

## 版权说明

- 上线资源以 `assets/runtime-manifest.json` 为审计边界，发布前必须逐项核验来源、授权与署名要求；
- 生成中间稿、参考图和第三方迁移素材不得仅因位于 `assets/` 就视为可发布素材；
- 历史人物为公共领域素材；英雄技能名与台词均为原创；
- 玩法机制为德州扑克公有规则的世界观包装，详见《群英决》策划案 V1.3（设计文档另存于设计仓库）。
