# 德州扑克底牌展示与牌谱权限

联机版采用以下统一房规，实时牌桌、断线恢复和牌局历史必须遵守同一套可见性规则。

## 实时展示

- 正常行动中，每名玩家只能看到自己的两张底牌。
- 玩家弃牌后，两张底牌继续隐藏；之后的结算不得把弃牌者加入亮牌名单。
- 其他玩家全部弃牌时，最后一名有效玩家直接获池，不要求公开底牌。
- 进入最终摊牌比大小时，所有仍未弃牌的玩家同时公开两张底牌，全桌看到相同信息。
- 只要至少一人全押且所有后续下注行动已经结束，所有仍有效的手牌立即公开，再继续发完公牌。
- 技能主动公开一张底牌时，仅该张转为全桌公开；另一张仍保持隐藏。

实现时禁止把底牌放入公共快照后再由前端隐藏。服务端只通过“本人私有底牌事件”或“全桌公开亮牌事件”发送牌值。

## 牌局历史

- SQLite 保存完整原始记录用于一致性与纠纷审计。
- 普通玩家只能查询自己实际参与过的牌局。
- 查询者自己的两张底牌始终可见。
- 对手只返回当时已向全桌公开的牌位；未公开位置返回 `null`。
- 公牌只保存结算时实际已经翻开的 0、3、4 或 5 张，不保存未来牌。
- 查询范围由 HttpOnly 登录 Cookie 决定，接口不接受客户端指定其他玩家编号。

## 规则依据

- [Poker TDA 2024 Rules 16–18](https://www.pokertda.com/view-poker-tda-rules/)
- [WSOP 2026 Official Tournament Rules](https://assets.wsopcdn.com/wsop/1a72ba28-781c-409d-a9c3-5ca13c4c5718.pdf)
- [PokerStars：Cards mucked in hand histories](https://www.pokerstars.com/help/articles/hh-mucked-cards-rule/33780/)
- [PokerStars：Hand histories](https://www.pokerstars.com/poker/learn/news/hand-histories-where-to-find-them-and-what-to-do-with-them/)
