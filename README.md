# qyj-online · 群英决自托管网页版

英雄对决表现 × 德州竞技内核。**单机人机对战 + 联机组队对战**，
零构建：纯 HTML/CSS/原生 ES Modules + Node WebSocket 权威对战服。
本项目完全独立，自带全部美术资产与游戏逻辑，无外部工程依赖。

## 快速开始

```bash
npm install          # 安装对战服依赖（ws）
npm run web          # 前端静态服务 → http://localhost:8080
npm run server       # 对战服务 → ws://localhost:8790（联机模式需要）
npm test             # 单机逻辑冒烟 + 双客户端联机端到端测试
```

打开 http://localhost:8080 → 首屏选"单机·人机对战"或"联机·组队对战"。
前端也可用任何静态服务器（`python -m http.server 8080` 等），
ES Modules 需要 http 协议，不能直接双击 index.html。

## 玩法概要

- 6 人局 / 12 回合 / 初始气血 1500、能量 2⚡；血祭每 3 回合翻倍
- 德州扑克内核零改动：2 枚暗牌（杀招令）+ 5 道天机（公共牌），
  佯攻⅓池 / 强攻½池 / 猛攻⅔池 / 决死全下，主池+边池结算
- 六英雄各带主动技+被动技（观天/魅惑/暗度陈仓/威压/奇货可居/坚壁），
  技能条件以两枚暗牌判定，每回合限一次
- 联机：队伍 ≤3 名真人，随机赐名可改名，房主随时开局，
  选将互斥（先选先得/60 秒超时随机分配），不足 6 人 AI 自动补位

## 目录结构

```
qyj-online/
├── index.html          # 入口
├── css/style.css       # 暖色水墨鎏金主题（英雄杀基调）
├── assets/             # 美术资产（AI 生成原创：立绘/13阶牌面/花色/牌背/背景）
├── js/
│   ├── game/           # 纯逻辑层（浏览器与 Node 对战服共用）
│   │   ├── config.js   #   数值表
│   │   ├── deck.js     #   牌组
│   │   ├── handeval.js #   7选5杀招评估
│   │   ├── winrate.js  #   蒙特卡洛胜率
│   │   ├── heroes.js   #   六英雄数据与技能判定
│   │   ├── ai.js       #   AI 性格决策（激进/紧手/诈唬/紧凶/松浪）
│   │   └── engine.js   #   回合状态机/下注轮/边池/技能
│   ├── net/remoteengine.js  # 联机镜像代理（接口与本地引擎对齐）
│   ├── ui/             # 界面层（模式选择/选将/对局/结算/联机大厅/演出）
│   └── main.js         # 入口与主循环
├── server/server.mjs   # Node WebSocket 权威对战服
│                       #（组队/选将互斥/AI补位/计时托管/暗令私发防透视）
└── test/               # smoke.mjs 单机冒烟 · mp_smoke.mjs 联机端到端
```

## 云主机部署（nginx + systemd）

1. 上传项目：

```bash
scp -r qyj-online/ user@your-host:/var/www/qyj-online
ssh user@your-host "cd /var/www/qyj-online && npm install"
```

2. 对战服务常驻（`/etc/systemd/system/qyj-server.service`）：

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
systemctl enable --now qyj-server
```

3. nginx 站点（静态前端 + 同域 /ws WebSocket 反代，HTTPS 下自动 WSS）：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/qyj-online;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

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

4. 在 `index.html` 的 `<head>` 里加一行，让联机走同域反代：

```html
<script>window.QYJ_WS_URL=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'</script>
```

（不设置时默认连 `ws://<当前域名>:8790`，适合本地开发直连。）

5. `nginx -s reload`。HTTPS 用 certbot 一键签发即可。

## 验证

```bash
npm test
# 期望：牌型评估自检11例 → 6局单机完赛 → MP-SMOKE ALL PASS
#（联机用例：建队/加入/改名/选将互斥/AI补位/打满/断线托管/再开局）
```

## 路线图

- [x] 单机人机对战（完整规则/6英雄技能/AI/演出）
- [x] 联机组队对战（权威服务器，多队伍并行，暗令只私发本人）
- [ ] 音效/BGM
- [ ] 断线重连（当前断线即托管到局终）

## 版权说明

- 全部美术资产为 AI 生成的原创素材；历史人物为公共领域；技能名与台词原创。
- 玩法设计详见《群英决》策划案 V1.3（设计文档另存于设计仓库）。
