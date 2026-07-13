# 群英决 · H5 联网版

群英决现已收敛为单一产品形态：**手机 H5 横屏联网版**。

- 唯一入口：`index.html`
- 仅支持横屏；竖屏显示阻断页，不允许进入游戏
- 所有玩家必须注册或登录后进入联网大厅
- 支持 6 人桌与 9 人桌
- 房主本人一名真人即可开局，剩余座位由服务器 AI 自动补齐
- 同一桌内英雄不可重复
- 对局、玩家资料、统计与牌局记录由服务端和 SQLite 统一持久化

项目不再提供 PC 页面、模式选择页或浏览器本地单机对局。所谓“单人游玩”仍然是完整的联网房间：一名真人作为房主，服务端补充 AI，因此前端、规则、身份和战绩链路只有一套。

## 目录

```text
index.html                 唯一 H5 入口
css/h5/                    H5 横屏界面
js/entry/h5.js             H5 启动与横屏缩放
js/ui/h5/                  登录、大厅、房间、选将、对局、结算
js/session/                联网会话与远程对局镜像
js/net/                    WebSocket 协议客户端
js/game/                   浏览器镜像与服务端共用的扑克/英雄规则
server/                    权威对战服务、账号 API、SQLite 持久化
assets/h5/                 H5 专用图片资源
test/e2e/                  H5 真实用户全流程自动化
```

## 本地运行

要求 Node.js 24 或更高版本。

```powershell
npm install
npm run server
```

另开一个终端：

```powershell
npm run web
```

访问：`http://localhost:8080/`

联网服务默认使用：

- WebSocket：`ws://localhost:8790`
- 账号 API：`http://localhost:8790/api/`
- SQLite：`server/data/qyj.sqlite`

首次进入需要注册账号。用户名和邮箱均可登录，重置密码使用注册邮箱。

## 一名真人开局

1. 登录后进入大厅。
2. 创建 6 人桌或 9 人桌。
3. 房间里只有房主本人也可以开始选将。
4. 选定英雄并开始游戏。
5. 服务端为剩余座位选择不重复英雄并补入 AI。

这个流程取代旧单机模式，使用与多人联机完全相同的服务端裁决、断线恢复、玩家统计和牌局记录链路。

## 构建与测试

```powershell
npm test
npm run test:server
npm run build:static
npm run test:e2e
```

发布构建输出到 `dist/public`，只包含 `index.html` 可达的 H5 代码和运行资源。

完整验证：

```powershell
npm run test:all
```

## 部署

静态站点托管 `dist/public`，并将 `/ws` 与 `/api/` 反向代理到 Node 服务。生产环境建议启用 HTTPS/WSS，并持久化备份 `server/data/qyj.sqlite`。

示例 Nginx 核心配置：

```nginx
location / {
    root /srv/qyj/dist/public;
    try_files $uri $uri/ /index.html;
}

location /ws {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

location /api/ {
    proxy_pass http://127.0.0.1:8790;
}
```

## 维护边界

- 前端新增功能只实现于 `js/ui/h5/` 与 `css/h5/`。
- 不新增 PC 专用入口、样式或视图。
- 不在浏览器内实例化权威 `Engine` 作为本地单机模式。
- 单人、多人统一通过 `OnlineSession → WebSocket → server`。
- 所有影响牌局的操作必须由服务端校验和广播。
