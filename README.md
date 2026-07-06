# qyj-online · 群英决

> 英雄对决表现 × 德州扑克竞技内核 · 自托管网页版（单机人机对战 + 联机组队对战）

**群英决**是一款以历史英雄对决为表现形式、以德州扑克为竞技内核的快节奏策略卡牌游戏。
玩家扮演诸葛亮、项羽等历史英雄，手握两枚暗藏的杀招令（底牌），随天时、地利、人和
（公共牌）逐步揭示战局，通过灌注气血（下注）向对手施压，以杀招（牌型）定胜负。
界面与交互参考经典国风卡牌游戏的武将牌美学，底层完整保留德州扑克久经验证的博弈规则。

- **零构建**：纯 HTML/CSS/原生 ES Modules，无打包器、无框架
- **零信任**：联机采用权威服务器架构，暗牌只私发本人，从协议层杜绝透视外挂
- **零外部依赖**：唯一的运行时依赖是对战服的 `ws`（WebSocket 库）
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

### 六英雄技能

每位英雄一个主动技（以两枚暗牌为发动条件，每回合限一次）+ 一个被动技：

| 英雄 | 类型 | 主动技 | 被动技 |
|---|---|---|---|
| 诸葛亮 | 侦查 | 观天 2⚡：窥探下一道天机 | 两令同花色 +1⚡ |
| 貂蝉 | 侦查 | 魅惑 3⚡：窥视一名对手一枚暗牌 | 亮招获胜 +1⚡ |
| 韩信 | 换牌 | 暗度陈仓 2⚡：弃换一枚暗牌 | 两令不成对且不同花色 +1⚡ |
| 项羽 | 控制 | 威压 2⚡：本轮对手不得加注（决死除外） | 不亮招夺池 +1⚡ |
| 吕不韦 | 经济 | 奇货可居 3⚡：本回合获胜额外+30%血池 | 所有夺池额外+10% |
| 廉颇 | 防御 | 坚壁 2⚡：本回合亮招若败返还50%气血 | 亮招落败 +1⚡ |

### 联机组队

- 队伍最多 **3 名真人**，进队随机赐名（战国风代号，可随时改名）
- 房主随时可开始；选将阶段**英雄不可重复**（先选先得、可换选、60 秒超时随机分配）
- 不足 6 人由 AI 自动补位（5 种性格：激进/紧手/诈唬/紧凶/松浪，英雄不重复）
- 行动限时 30 秒（可消耗 1⚡ 延长 30 秒），超时与断线自动托管

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
  六英雄技能、AI 决策、回合状态机（下注轮/主池边池/技能/演出节奏），零 DOM/零 Node API
- **单机模式**：浏览器内直接实例化引擎
- **联机模式**：服务器实例化引擎（权威），客户端 `RemoteEngine` 镜像公开状态快照并转发操作；
  对局界面 `battle.js` 对两种引擎完全无感
- **协议**：WebSocket + JSON。客户端→服务器为 `{cmd:...}` 命令
  （create/join/leave/rename/startPick/pick/startGame/act/skill/extend/…），
  服务器→客户端为 `{ev:..., a:载荷, s:公开快照}` 事件流；
  **暗牌通过 `hole` 事件只私发给持有者本人**

```
qyj-online/
├── index.html          # 入口
├── package.json        # npm run web / server / test
├── css/style.css       # 暖色水墨鎏金主题
├── assets/             # 美术资产（AI 生成原创：6英雄立绘/13阶牌面/花色/牌背/背景）
├── js/
│   ├── game/           # 纯逻辑层（两端共用）
│   ├── net/            # RemoteEngine 联机镜像代理
│   ├── ui/             # 模式选择/选将/对局/结算/联机大厅/演出特效
│   └── main.js         # 入口与 rAF 主循环
├── server/             # Node WebSocket 权威对战服（独立 package.json，依赖 ws）
└── test/               # 单机冒烟 + 联机双客户端端到端测试
```

---

## 本地运行

**环境要求**：Node.js ≥ 18（推荐 20+）。前端静态服务可用 Node 或 Python 任选。

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

浏览器打开 **http://localhost:8080**：

- **单机·人机对战**：无需对战服，选英雄直接开打（1 真人 + 5 AI）
- **联机·组队对战**：需要对战服在线；默认连接 `ws://<当前域名>:8790`

> 注意：ES Modules 要求 http(s) 协议加载，**直接双击 index.html（file://）无法运行**。

---

## 云主机部署（nginx + systemd）

以 Ubuntu/Debian 为例，假设部署到 `/var/www/qyj-online`、域名 `your-domain.com`。

### 1. 安装环境（服务器上）

```bash
sudo apt update && sudo apt install -y nginx nodejs npm
node -v   # 需要 ≥ 18，过旧可用 NodeSource 或 nvm 安装新版
```

### 2. 上传项目并安装依赖

```bash
# 本机执行
scp -r qyj-online/ user@your-host:/var/www/qyj-online
# 或在服务器上直接 git clone https://github.com/wade004/qyj-online.git

# 服务器执行
cd /var/www/qyj-online && npm install
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

    root /var/www/qyj-online;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # 美术资产文件名含时间戳指纹，可长缓存
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
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

编辑 `index.html`，在 `<head>` 内加一行（让联机走 `/ws` 反代而非直连 8790 端口）：

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
```

包含两套：

| 测试 | 覆盖 |
|---|---|
| `test/smoke.mjs` | 牌型评估 11 例自检（皇家同花顺~高牌+轮子顺）；6 局完整对局（12 回合完赛、气血守恒、无负血） |
| `test/mp_smoke.mjs` | 真实双 WebSocket 客户端端到端：建队/加入/改名(超长拒绝)/选将互斥/AI补位开局(英雄唯一)/打满出冠军/战后回房再开局/**对局中断线托管** |

---

## 二次开发指南

- **调数值**：全部集中在 `js/game/config.js`（血祭曲线/攻击档位/行动时限/AI参数/加成比例）
- **加英雄**：在 `js/game/heroes.js` 增加条目 + 在 `checkCondition/dealPassiveEnergy`
  补技能判定 + 在 `js/game/engine.js` 的 `useSkill` 补技能效果，立绘放 `assets/`
- **改界面主题**：`css/style.css` 顶部 `:root` 色板
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

- 全部美术资产（英雄立绘、牌面、花色符号、牌背、背景）均为 AI 生成的**原创素材**；
- 历史人物为公共领域素材；英雄技能名与台词均为原创；
- 玩法机制为德州扑克公有规则的世界观包装，详见《群英决》策划案 V1.3（设计文档另存于设计仓库）。
