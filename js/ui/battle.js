// ============================================================================
// battle.js - 对局界面（复刻 Maker 版最终设计：英雄杀式武将牌 + demo-v2 操作区）
// ============================================================================

import * as Config from '../game/config.js';
import { describe } from '../game/handeval.js';
import * as WinRate from '../game/winrate.js';
import * as Advisor from '../game/advisor.js?v=pot-metrics';
import { cardText } from '../game/engine.js';
import * as FX from './effects.js';
import { playSFX } from '../audio.js';

const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const ATTACK_NAME_BY_KEY = Object.fromEntries(
  Config.ATTACK_TIERS.map((tier) => [tier.key, tier.name]),
);

export function formatActionHint(key, amount = 0, allIn = false) {
  const value = Math.max(0, Math.round(Number(amount) || 0));
  const withAmount = (label) => value > 0 ? `${label} ${value}` : label;
  if (key === 'smallBlind') return withAmount('小盲');
  if (key === 'bigBlind') return withAmount('大盲');
  if (key === 'fold') return '退避';
  if (key === 'check') return '静观';
  if (key === 'call') return withAmount(allIn ? '决死应战' : '应战');
  if (key === 'allin') return withAmount('决死');
  if (ATTACK_NAME_BY_KEY[key]) return withAmount(ATTACK_NAME_BY_KEY[key]);
  return value > 0 ? `已投入 ${value}` : '';
}

function actionHintTone(key, allIn = false) {
  if (key === 'fold') return 'fold';
  if (key === 'smallBlind' || key === 'bigBlind') return 'blind';
  if (key === 'allin' || allIn) return 'allin';
  if (ATTACK_NAME_BY_KEY[key]) return 'attack';
  return 'defend';
}

// ---------------- 杀招令卡牌组件 ----------------

function makeCard(sizeClass) {
  const el = h(`<div class="card ${sizeClass}">
    <img class="suit-icon" alt="" style="display:none">
    <div class="cardback"><span class="slot-name"></span></div>
  </div>`);
  const suitIcon = el.querySelector('.suit-icon');
  const back = el.querySelector('.cardback');
  const slotName = el.querySelector('.slot-name');
  return {
    el,
    setCard(card) {
      el.style.backgroundImage = `url('${Config.RANK_FACE_IMGS[card.rank]}')`;
      suitIcon.src = Config.SUIT_IMGS[card.suit];
      suitIcon.style.display = '';
      back.style.display = 'none';
      el.classList.toggle('red', Config.SUITS[card.suit].red);
      el.classList.toggle('black', !Config.SUITS[card.suit].red);
    },
    faceDown(slot = '') {
      back.style.display = '';
      slotName.textContent = slot;
      el.classList.remove('red', 'black', 'hl');
    },
    highlight(on) {
      el.classList.toggle('hl', on);
    },
    revealAnim() {
      el.classList.remove('reveal-anim');
      void el.offsetWidth;
      el.classList.add('reveal-anim');
    },
  };
}

// ---------------- 武将牌（座位）组件 ----------------

function makeSeat(p, isMe) {
  const nameChars = [...p.hero.name].map((c) => `<span>${c}</span>`).join('');
  const wrap = h(`<div class="seat-wrap">
    <div class="seat-bet">&nbsp;</div>
    <div class="seat ${isMe ? 'me' : 'opp'}">
      <div class="portrait" style="background-image:url('${p.hero.portrait}')"></div>
      <div class="name-strip">${nameChars}</div>
      <div class="dealer">庄</div>
      <div class="status"></div>
      <div class="hand-name"></div>
      <div class="reveal-row"></div>
      ${p.playerName ? `<div class="pname">${p.playerName}</div>` : ''}
      <div class="turnbar"><div class="tb-fill"></div></div>
      <div class="hpbar">
        <div class="hp-no">${isMe ? '你' : p.idx}</div>
        <div class="hp-mid"><div class="hp-fill"></div><div class="hp-txt"></div></div>
        <div class="hp-en"></div>
      </div>
    </div>
  </div>`);
  const seat = wrap.querySelector('.seat');
  const revealRow = wrap.querySelector('.reveal-row');
  const rToks = [makeCard('card-mini'), makeCard('card-mini')];
  for (const t of rToks) {
    t.faceDown();
    t.el.style.display = 'none';
    revealRow.appendChild(t.el);
  }
  return {
    root: wrap, seat,
    betEl: wrap.querySelector('.seat-bet'),
    statusEl: wrap.querySelector('.status'),
    handEl: wrap.querySelector('.hand-name'),
    hpFill: wrap.querySelector('.hp-fill'),
    hpTxt: wrap.querySelector('.hp-txt'),
    enEl: wrap.querySelector('.hp-en'),
    turnFill: wrap.querySelector('.tb-fill'),
    revealToks: rToks,
    tokens: rToks, // 玩家座位在装配时改指向外置大牌
  };
}

// ---------------- 主装配 ----------------

/**
 * @param {Engine} engine
 * @param {object} listeners 与引擎共享的监听表（本函数负责填充）
 * @param {number} myIdx
 * @param {function} onGameOver
 * @returns {{ tick(dt:number):void }}
 */
export function attachBattle(engine, listeners, myIdx, onGameOver) {
  const app = document.getElementById('app');
  const players = engine.players;
  const me = players[myIdx];
  const rel = (n) => ((myIdx - 1 + n) % Config.PLAYER_COUNT) + 1;

  // ---- DOM 骨架 ----
  const screen = h(`<div class="screen">
    <div class="topbar">
      <span class="tb-title">群 英 决</span>
      <span class="tb-round">第 1/${Config.MAX_ROUNDS} 回合</span>
      <span class="tb-blind">血祭 10/20</span>
      <span class="tb-spacer"></span>
      <label class="advisor-toggle" title="显示或隐藏本地策略建议">
        <input class="advisor-toggle-input" type="checkbox" checked>
        <span>AI辅助</span>
      </label>
      <span class="tb-hp">你的气血 ${Config.INIT_HP}</span>
      <span class="tb-energy">能量 ⚡${Config.INIT_ENERGY}</span>
    </div>
    <div class="logpanel">
      <div class="lp-head"><span class="lp-title">战 报</span><span class="lp-toggle">点击折叠</span></div>
      <div class="lp-body"></div>
    </div>
    <div class="table-area">
      <div class="seats-top"></div>
      <div class="mid-row">
        <div class="mid-left"></div>
        <div class="board-col">
          <div class="board-cards"></div>
          <div class="pot">血池 0</div>
          <div class="peek"></div>
        </div>
        <div class="mid-right"></div>
      </div>
    </div>
    <div class="bottombar">
      <div class="bb-me"></div>
      <div class="bb-skill">
        <div class="sk-head">◆ 英雄技能</div>
        <button class="sk-btn" disabled>${me.hero.skillName}（${me.hero.skillCost}⚡）</button>
        <div class="sk-state"></div>
      </div>
      <div class="bb-spacer"></div>
      <div class="bb-hand">
        <div class="hand-cards"></div>
        <div class="cur-hand">当前：--</div>
      </div>
      <div class="bb-spacer"></div>
      <div class="bb-right">
        <div class="gto-advice" aria-live="polite">
          <div class="ga-head">
            <span class="ga-label">GTO近似</span>
            <span class="ga-confidence"></span>
          </div>
          <div class="ga-options"></div>
          <div class="ga-reason"></div>
          <div class="ga-meta"></div>
        </div>
        <div class="strength-row">
          <span class="st-label">胜算</span>
          <div class="strength-outer"><div class="strength-bar"></div></div>
          <span class="strength-txt">--</span>
        </div>
        <div class="timer-row">
          <div class="timer-outer"><div class="timer-bar"></div></div>
          <span class="timer-txt">30s</span>
          <button class="extend-btn">+30秒 (1⚡)</button>
        </div>
        <div class="btn-grid">
          <div class="bg-row">
            <button class="btn-fold" disabled>退避</button>
            <button class="btn-call" disabled>静观</button>
            <button class="btn-allin" disabled>决死</button>
          </div>
          <div class="bg-row">
            <button class="btn-raiseS" disabled>佯攻</button>
            <button class="btn-raiseM" disabled>强攻</button>
            <button class="btn-raiseL" disabled>猛攻</button>
          </div>
        </div>
      </div>
    </div>
  </div>`);
  app.replaceChildren(screen);

  const $ = (sel) => screen.querySelector(sel);

  // ---- 座位（视角旋转：自己底部，其余 rel1中右/rel2上右/rel3上中/rel4上左/rel5中左）----
  const seats = {};
  const topRow = $('.seats-top');
  for (const n of [4, 3, 2]) {
    const s = makeSeat(players[rel(n)], false);
    seats[rel(n)] = s;
    topRow.appendChild(s.root);
  }
  const sLeft = makeSeat(players[rel(5)], false);
  seats[rel(5)] = sLeft;
  $('.mid-left').appendChild(sLeft.root);
  const sRight = makeSeat(players[rel(1)], false);
  seats[rel(1)] = sRight;
  $('.mid-right').appendChild(sRight.root);
  const sMe = makeSeat(me, true);
  seats[myIdx] = sMe;
  $('.bb-me').appendChild(sMe.root);

  // 玩家外置手牌
  const handCards = $('.hand-cards');
  const pToks = [makeCard('card-hand'), makeCard('card-hand')];
  for (const t of pToks) {
    t.faceDown();
    handCards.appendChild(t.el);
  }
  seats[myIdx].tokens = pToks;

  // 天机
  const boardToks = [];
  const boardBox = $('.board-cards');
  for (let slot = 1; slot <= 5; slot++) {
    const t = makeCard('card-board');
    t.faceDown(Config.BOARD_SLOT_NAMES[slot]);
    boardToks.push(t);
    boardBox.appendChild(t.el);
  }

  // ---- 战报 ----
  const logBody = $('.lp-body');
  $('.lp-head').addEventListener('click', () => {
    const lp = $('.logpanel');
    lp.classList.toggle('collapsed');
    $('.lp-toggle').textContent = lp.classList.contains('collapsed') ? '点击展开' : '点击折叠';
  });
  let logCount = 0;
  function addLog(text, kind = 'info') {
    const div = document.createElement('div');
    div.className = `lk-${kind}`;
    div.textContent = text;
    logBody.appendChild(div);
    if (++logCount > 80) { logBody.firstElementChild.remove(); logCount--; }
    logBody.scrollTop = logBody.scrollHeight;
  }

  // ---- 技能提示浮层 ----
  const tip = document.getElementById('tip');
  function showTip(idx, x, y) {
    const p = players[idx];
    const who = idx === myIdx ? '（你）' : p.playerName ? `（${p.playerName}）` : `（${idx}号位）`;
    tip.innerHTML =
      `<div class="st-title">${p.hero.name} · ${p.hero.type}${who}</div>` +
      `<div class="st-active">主动【${p.hero.skillName}】${p.hero.skillCost}⚡ · 每回合限一次</div>` +
      `<div>效果：${p.hero.skillDesc}</div>` +
      `<div class="st-cond">发动条件：${p.hero.condDesc}（以两枚暗令判定）</div>` +
      `<div class="st-passive">被动：${p.hero.passiveDesc}</div>`;
    tip.hidden = false;
    const w = 236, hh = tip.offsetHeight || 150;
    let tx = Math.max(6, Math.min(x - w / 2, window.innerWidth - w - 6));
    let ty = y > window.innerHeight / 2 ? y - hh - 12 : y + 12;
    tip.style.left = `${tx}px`;
    tip.style.top = `${Math.max(6, ty)}px`;
  }
  for (const [idx, s] of Object.entries(seats)) {
    s.seat.addEventListener('mouseenter', (e) => showTip(Number(idx), e.clientX, e.clientY));
    s.seat.addEventListener('mouseleave', () => { tip.hidden = true; });
    s.seat.addEventListener('click', (e) => {
      showTip(Number(idx), e.clientX, e.clientY);
      setTimeout(() => { tip.hidden = true; }, 3500);
    });
  }

  // ---- 状态刷新 ----
  const topRound = $('.tb-round'), topBlind = $('.tb-blind'),
    topHp = $('.tb-hp'), topEnergy = $('.tb-energy'),
    potEl = $('.pot'), peekEl = $('.peek'),
    curHandEl = $('.cur-hand'),
    stBar = $('.strength-bar'), stTxt = $('.strength-txt'),
    adviceEl = $('.gto-advice'), adviceOptions = $('.ga-options'),
    adviceConfidence = $('.ga-confidence'), adviceReason = $('.ga-reason'),
    adviceMeta = $('.ga-meta'),
    advisorToggle = $('.advisor-toggle-input'),
    timerRow = $('.timer-row'), timerBar = $('.timer-bar'), timerTxt = $('.timer-txt'),
    extendBtn = $('.extend-btn'),
    skillBtn = $('.sk-btn'), skillState = $('.sk-state');

  function hpColor(pct) {
    return pct >= 0.6 ? '#5cc86c' : pct >= 0.3 ? '#e6ba3c' : '#dc4638';
  }
  function updateHp(idx) {
    const p = players[idx], s = seats[idx];
    s.hpTxt.textContent = p.hp;
    const pct = Math.max(0, Math.min(1, p.hp / Config.INIT_HP));
    s.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    s.hpFill.style.background = hpColor(pct);
    if (idx === myIdx) topHp.textContent = `你的气血 ${p.hp}`;
  }
  function updateEnergy(idx) {
    const p = players[idx];
    seats[idx].enEl.textContent = `⚡${p.energy}`;
    if (idx === myIdx) topEnergy.textContent = `能量 ⚡${p.energy}`;
  }
  const actionHints = new Map();

  function setActionHint(idx, key, amount = 0) {
    const allIn = Boolean(players[idx]?.allIn);
    actionHints.set(idx, {
      text: formatActionHint(key, amount, allIn),
      tone: actionHintTone(key, allIn),
    });
    updateBet(idx);
  }

  function clearActionHints() {
    actionHints.clear();
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) updateBet(i);
  }

  function updateBet(idx) {
    const p = players[idx];
    const el = seats[idx].betEl;
    const hint = actionHints.get(idx);
    el.classList.remove('action-fold', 'action-blind', 'action-allin', 'action-attack', 'action-defend');
    if (hint?.text) {
      el.textContent = `⚔ ${hint.text}`;
      el.classList.add(`action-${hint.tone}`);
    } else if (p.betStreet > 0) {
      el.textContent = `⚔ 已投入 ${p.betStreet}`;
    } else {
      el.textContent = '\u00a0';
    }
  }
  function renderPotLayers(layers) {
    potEl.replaceChildren(...layers.map((layer) => {
      const actor = layer.actorIdx ? players[layer.actorIdx] : null;
      const ratioText = layer.wagerAmount > 0 && layer.amount > 0
        ? `${Math.round(layer.ratio * 100)}%池` : '';
      const detail = layer.wagerAmount > 0
        ? `<em>${actor?.hero?.name || ''}下注 ${layer.wagerAmount}${ratioText ? ` · ${ratioText}` : ''}</em>`
        : '<em>本阶段暂无主动下注</em>';
      return h(`<span class="pot-layer ${layer.kind || 'main'}">
        <span class="pot-value"><small>${layer.label}</small><strong>${layer.amount}</strong></span>
        ${layer.kind === 'reference' ? detail : ''}
      </span>`);
    }));
  }
  function clearPot() {
    renderPotLayers([{ label: '当前血池', amount: 0, kind: 'main' }]);
  }
  function updatePot() {
    const showReference = engine.waitingIdx === myIdx;
    const layers = engine.getPotDisplay?.(showReference)
      || [{ label: '当前血池', amount: engine.totalPot(), kind: 'main' }];
    renderPotLayers(layers);
  }
  function refreshAll() {
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      updateHp(i); updateEnergy(i); updateBet(i);
    }
    updatePot();
  }
  function setStatus(idx, text, color = '') {
    const el = seats[idx].statusEl;
    el.textContent = text;
    if (color) el.style.color = color;
  }
  function highlightTurn(idx) {
    for (const [i, s] of Object.entries(seats)) {
      s.seat.classList.toggle('turn', Number(i) === idx);
    }
  }

  // 座位行动倒计时条
  let turnIdx = null, turnLeft = 0;
  function showTurnBar(idx) {
    for (const [i, s] of Object.entries(seats)) {
      s.seat.classList.toggle('timing', Number(i) === idx);
    }
    turnIdx = idx;
    turnLeft = Config.ACTION_TIME;
    seats[idx].turnFill.style.width = '100%';
    seats[idx].turnFill.classList.remove('low');
  }
  function hideTurnBars() {
    for (const s of Object.values(seats)) s.seat.classList.remove('timing');
    turnIdx = null;
  }

  let adviceCacheKey = '', adviceCache = null;
  let advisorEnabled = true;
  try {
    advisorEnabled = localStorage.getItem('qyj-ai-assist') !== 'off';
  } catch {
    // Local analysis still works when storage is unavailable.
  }
  advisorToggle.checked = advisorEnabled;

  function hideDecisionAdvice() {
    adviceEl.className = 'gto-advice';
  }

  function renderDecisionAdvice(advice) {
    if (!advice) {
      hideDecisionAdvice();
      return;
    }
    const confidenceLabels = { high: '高把握', medium: '中等把握', low: '低频分支' };
    adviceEl.className = `gto-advice show ${advice.tone}`;
    adviceConfidence.textContent = confidenceLabels[advice.confidence] || '';
    adviceOptions.replaceChildren(...advice.suggestions.slice(0, 3).map((suggestion, index) => {
      const option = document.createElement('span');
      option.className = `ga-option${index === 0 ? ' primary' : ''}`;
      const rank = document.createElement('b');
      rank.textContent = String(index + 1);
      const action = document.createElement('strong');
      action.textContent = suggestion.label;
      const frequency = document.createElement('em');
      frequency.textContent = `${suggestion.frequency}%`;
      option.append(rank, action, frequency);
      return option;
    }));
    adviceReason.textContent = advice.reason;
    const meta = [advice.metrics];
    if (advice.suggestions.length > 1) meta.push(advice.mixed ? '混合频率节点' : '低频备选');
    adviceMeta.textContent = meta.filter(Boolean).join(' · ');
  }

  // ---- 胜算 / 当前杀招 / 决策建议 ----
  function refreshAdvice() {
    const p = me;
    if (!p || p.hole.length < 2) return;
    const board = engine.revealedBoard();
    const cards = [...p.hole, ...board];
    const d = describe(cards);
    curHandEl.textContent = `当前：${d.name}（${d.poker}）`;
    curHandEl.classList.toggle('good', d.cat >= 3);
    // 组合高亮
    pToks.forEach((t) => t.highlight(false));
    board.forEach((_, i) => boardToks[i].highlight(false));
    for (const c of d.core) {
      if (c === p.hole[0]) pToks[0].highlight(true);
      if (c === p.hole[1]) pToks[1].highlight(true);
      board.forEach((bc, i) => { if (c === bc) boardToks[i].highlight(true); });
    }
    let decisionAdvice = null;
    if (advisorEnabled && awaiting && lastOpts && engine.waitingIdx === myIdx) {
      const key = Advisor.decisionKey(engine, p, lastOpts);
      if (key !== adviceCacheKey) {
        adviceCacheKey = key;
        adviceCache = Advisor.analyzeDecision(engine, p, lastOpts);
      }
      decisionAdvice = adviceCache;
      renderDecisionAdvice(decisionAdvice);
    } else {
      hideDecisionAdvice();
    }

    // 胜算（demo-v2 四档）
    if (!p.folded && p.alive) {
      const opp = engine.activePlayers().length - 1;
      if (opp >= 1) {
        const wr = decisionAdvice?.equity
          ?? WinRate.estimate(p.hole, board, opp, Config.PLAYER_SIMS);
        const pct = Math.round(wr * 100);
        let verdict, cls;
        if (pct < 30) { verdict = '劣势'; cls = 'st-bad'; }
        else if (pct < 50) { verdict = '胶着'; cls = 'st-mid'; }
        else if (pct < 72) { verdict = '优势'; cls = 'st-good'; }
        else { verdict = '碾压'; cls = 'st-crush'; }
        stBar.style.width = `${pct}%`;
        stTxt.textContent = `${pct}% ${verdict}`;
        stTxt.className = `strength-txt ${cls}`;
      }
    } else {
      stBar.style.width = '0%';
      stTxt.textContent = '--';
      stTxt.className = 'strength-txt';
    }
  }

  // ---- 行动按钮（固定 3×2） ----
  const btns = {
    fold: $('.btn-fold'), call: $('.btn-call'), allin: $('.btn-allin'),
    raiseS: $('.btn-raiseS'), raiseM: $('.btn-raiseM'), raiseL: $('.btn-raiseL'),
  };
  const acts = {};
  let awaiting = false, timeLeft = 0, lastOpts = null;

  advisorToggle.addEventListener('change', () => {
    advisorEnabled = advisorToggle.checked;
    try {
      localStorage.setItem('qyj-ai-assist', advisorEnabled ? 'on' : 'off');
    } catch {
      // Keep the switch functional for this session when storage is unavailable.
    }
    refreshAdvice();
  });

  function hideActionUI() {
    awaiting = false;
    hideDecisionAdvice();
    for (const b of Object.values(btns)) b.disabled = true;
    extendBtn.disabled = true;
    timerRow.style.visibility = 'hidden';
  }
  function onPlayerAction(act) {
    if (!engine.waitingIdx) return;
    hideActionUI();
    engine.playerAct(act);
  }
  for (const [key, b] of Object.entries(btns)) {
    b.addEventListener('click', () => { if (acts[key]) onPlayerAction(acts[key]); });
  }
  extendBtn.addEventListener('click', () => {
    if (awaiting && engine.extendTime(myIdx)) timeLeft += Config.EXTEND_TIME;
  });

  function updateActionButtons(opts) {
    acts.fold = { type: 'fold' };
    btns.fold.disabled = false;
    if (opts.canCheck) {
      btns.call.textContent = '静观';
      acts.call = { type: 'check' };
    } else if (opts.callAmt >= opts.allinAmt) {
      btns.call.textContent = `决死应战 ${opts.callAmt}`;
      acts.call = { type: 'call' };
    } else {
      btns.call.textContent = `应战 ${opts.callAmt}`;
      acts.call = { type: 'call' };
    }
    btns.call.disabled = false;
    acts.allin = opts.canAllIn === false ? null : { type: 'allin' };
    btns.allin.disabled = opts.canAllIn === false;
    const byKey = {};
    for (const tier of opts.tiers) byKey[tier.key] = tier;
    const slotMap = { raiseS: 'feint', raiseM: 'strike', raiseL: 'fierce' };
    for (const [slot, tkey] of Object.entries(slotMap)) {
      const tier = byKey[tkey];
      const b = btns[slot];
      if (tier) {
        b.textContent = `${tier.name} ${tier.cost}`;
        b.disabled = false;
        b.classList.remove('hide');
        acts[slot] = { type: 'raise', tier };
      } else {
        b.disabled = true;
        b.classList.add('hide');
        acts[slot] = null;
      }
    }
  }

  // ---- 技能 ----
  function refreshSkillPanel() {
    const availability = engine.skillAvailability(myIdx);
    skillBtn.disabled = !availability.ok;
    const cost = availability.cost ?? me.hero.skillCost;
    skillBtn.textContent = `${me.hero.skillName}（${cost}⚡）`;
    skillState.textContent = availability.reason || '';
    skillState.classList.toggle('ok', availability.ok);
  }

  function openSkillChoice(input) {
    const mask = h(`<div class="result-mask skill-choice-mask">
      <div class="result-box skill-choice-box">
        <h1>${input.title}</h1>
        <div class="skill-choice-step"></div>
        <div class="skill-choice-list"></div>
      </div>
    </div>`);
    const list = mask.querySelector('.skill-choice-list');
    const step = mask.querySelector('.skill-choice-step');
    const selection = {};
    const fields = input.fields || [];
    const renderField = (index) => {
      const field = fields[index];
      if (!field) {
        mask.remove();
        engine.useSkill(myIdx, selection);
        return;
      }
      step.textContent = fields.length > 1 ? `${index + 1}/${fields.length} · ${field.label}` : field.label;
      list.replaceChildren();
      for (const option of field.options || []) {
        const button = h(`<button class="skill-choice-option">
          <strong>${option.label}</strong>
          <span>${option.description || ''}</span>
        </button>`);
        button.addEventListener('click', () => {
          selection[field.key] = option.value;
          renderField(index + 1);
        });
        list.appendChild(button);
      }
    };
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    screen.appendChild(mask);
    renderField(0);
  }

  skillBtn.addEventListener('click', () => {
    if (!engine.canUseSkill(myIdx)) return;
    const input = engine.getSkillPrompt(myIdx);
    if (input && input.fields?.length) openSkillChoice(input);
    else engine.useSkill(myIdx);
  });

  // ---- 回合重置 ----
  function resetRoundUI(dealerIdx) {
    actionHints.clear();
    for (const [iStr, s] of Object.entries(seats)) {
      const i = Number(iStr);
      const p = players[i];
      s.betEl.textContent = '\u00a0';
      s.betEl.classList.remove('action-fold', 'action-blind', 'action-allin', 'action-attack', 'action-defend');
      s.handEl.textContent = '';
      s.seat.classList.remove('folded');
      if (p.alive) setStatus(i, '');
      else setStatus(i, '阵亡', 'var(--red)');
      if (i === myIdx) {
        pToks.forEach((t) => t.faceDown());
      } else {
        s.revealToks.forEach((t) => { t.faceDown(); t.el.style.display = 'none'; });
      }
      s.seat.classList.toggle('dealer-on', i === dealerIdx);
    }
    boardToks.forEach((t, i) => { t.faceDown(Config.BOARD_SLOT_NAMES[i + 1]); t.highlight(false); });
    hideTurnBars();
    clearPot();
    peekEl.textContent = '';
    hideActionUI();
  }

  // ---- 引擎事件接线 ----
  listeners.onSync = refreshAll;
  listeners.onLog = addLog;
  listeners.onRoundStart = (round, blinds, dealerIdx) => {
    topRound.textContent = `第 ${round}/${Config.MAX_ROUNDS} 回合`;
    topBlind.textContent = `血祭 ${blinds.sb}/${blinds.bb}`;
    resetRoundUI(dealerIdx);
  };
  listeners.onDeal = () => {
    playSFX('draw');
    if (me.alive && me.hole.length >= 2) {
      pToks[0].setCard(me.hole[0]);
      pToks[1].setCard(me.hole[1]);
    }
    refreshAdvice();
    refreshSkillPanel();
  };
  listeners.onBlindsPosted = (sbIdx, sbAmt, bbIdx, bbAmt) => {
    setActionHint(sbIdx, 'smallBlind', sbAmt);
    setActionHint(bbIdx, 'bigBlind', bbAmt);
    updatePot();
  };
  listeners.onTurnStart = (idx) => {
    highlightTurn(idx);
    showTurnBar(idx);
  };
  listeners.onAwaitAction = (idx, opts, remain) => {
    lastOpts = opts;
    updateActionButtons(opts);
    if (!awaiting) { awaiting = true; timeLeft = remain || Config.ACTION_TIME; }
    else if (remain) timeLeft = remain;
    timerRow.style.visibility = 'visible';
    extendBtn.disabled = me.energy < Config.EXTEND_COST;
    refreshAdvice();
    refreshSkillPanel();
    updatePot();
  };
  listeners.onAction = (idx, key, amount = 0) => {
    hideTurnBars();
    setActionHint(idx, key, amount); updatePot();
    if (key === 'fold') {
      setStatus(idx, '退避', 'var(--text-faint)');
      seats[idx].seat.classList.add('folded');
    } else if (key === 'allin') {
      setStatus(idx, '决死！', 'var(--red)');
      playSFX('equip');
    } else if (key === 'call' || key === 'check') {
      playSFX('drawx');
    } else if (ATTACK_NAME_BY_KEY[key]) {
      playSFX('draw');
    }
    if (idx === myIdx) hideActionUI();
  };
  listeners.onStreet = (street, revealTo) => {
    for (let slot = 1; slot <= revealTo; slot++) {
      const t = boardToks[slot - 1];
      if (t.el.querySelector('.cardback').style.display !== 'none') {
        t.setCard(engine.board[slot - 1]);
        t.revealAnim();
      }
    }
    clearActionHints();
    updatePot();
    peekEl.textContent = '';
    refreshAdvice();
    refreshSkillPanel();
  };
  listeners.onHpChange = (idx) => {
    const p = players[idx];
    const oldHp = seats[idx].hpFill.style.width;
    updateHp(idx);
    // Play damage/recover sound based on HP change
    const newPct = Math.max(0, Math.min(1, p.hp / Config.INIT_HP));
    if (oldHp && oldHp !== '') {
      const oldPct = parseFloat(oldHp) / 100;
      if (newPct < oldPct) playSFX(p.hero.gender === 'female' ? 'damageFemale' : 'damageMale');
      else if (newPct > oldPct) playSFX('recover');
    }
  };
  listeners.onEnergyChange = updateEnergy;
  listeners.onHoleChange = (idx) => {
    if (idx === myIdx) {
      pToks[0].setCard(me.hole[0]);
      pToks[1].setCard(me.hole[1]);
      refreshAdvice();
    }
  };
  listeners.onSkill = (idx, skillId, skillName, presentation = {}) => {
    playSFX(presentation.sfx || 'judge');
    FX.banner(skillName, `${players[idx].hero.name} · ${players[idx].hero.type}`, presentation.tone || 'var(--purple)');
  };
  listeners.onPassive = (idx, skillId, skillName, presentation = {}) => {
    playSFX(presentation.sfx || 'draw');
    const [x, y] = FX.centerOf(seats[idx].seat);
    FX.floatText(x, y - 20, `【${skillName}】`, presentation.tone || 'var(--gold-bright)', 16);
  };
  listeners.onSkillEffect = (idx, skillId, skillName, presentation = {}) => {
    playSFX(presentation.sfx || 'recover');
    const [x, y] = FX.centerOf(seats[idx].seat);
    FX.floatText(x, y - 20, `【${skillName}】生效`, presentation.tone || 'var(--gold-bright)', 16);
  };
  listeners.onQuote = (idx, text) => FX.bubble(seats[idx].seat, text);
  listeners.onSkillResult = (idx, result) => {
    if (idx !== myIdx || !result) return;
    if (result.kind === 'peek_board') {
      peekEl.textContent = `观天 · 下一道天机：${cardText(result.card)}`;
    } else if (result.kind === 'peek_hole') {
      const t = seats[result.targetIdx].revealToks[result.cardIdx - 1];
      t.setCard(result.card);
      t.el.style.display = '';
      t.el.style.borderColor = 'var(--purple)';
      t.el.style.boxShadow = '0 0 10px rgba(197,139,255,.6)';
      addLog(`魅惑窥视：${result.targetIdx}号位 ${players[result.targetIdx].hero.name} 的一枚暗令是 ${cardText(result.card)}`, 'skill');
    } else if (result.kind === 'prediction') {
      const labels = {
        showdown: '亮招决胜', uncontested: '兵不血刃', fold: '退避',
        defend: '守势', attack: '攻势', red: '红色', black: '黑色',
        low: '一对及以下', high: '两对及以上',
      };
      peekEl.textContent = `技能预测 · 已选择：${labels[result.choice] || result.choice}`;
    } else if (result.kind === 'peek_board_suit') {
      peekEl.textContent = `望月 · 下一道天机花色：${Config.SUITS[result.suit].name}`;
    } else if (result.kind === 'strength_band') {
      const labels = { low: '低', medium: '中', high: '高' };
      peekEl.textContent = `观辞 · ${result.targetIdx}号位当前胜率区间：${labels[result.band]}`;
    } else if (result.kind === 'copy_passive') {
      peekEl.textContent = `造化 · 已复制【${result.skillName}】`;
    }
  };
  listeners.onSkillPublicResult = (idx, result) => {
    if (!result || result.kind !== 'reveal_self') return;
    if (idx !== myIdx) {
      const token = seats[idx].revealToks[result.cardIdx - 1];
      token.setCard(result.card);
      token.el.style.display = '';
    }
    addLog(`${players[idx].hero.name}公开了一枚暗令：${cardText(result.card)}`, 'skill');
  };
  listeners.onPotAwarded = (winners, amount, uncontested, bonus, netWinnings = {}) => {
    const [fx0, fy0] = FX.centerOf(potEl);
    for (const wIdx of winners) {
      const [tx, ty] = FX.centerOf(seats[wIdx].seat);
      const net = netWinnings[wIdx] ?? amount + (bonus || 0) - players[wIdx].betRound;
      FX.potFly(fx0, fy0, tx, ty, () => {
        FX.floatText(tx, ty - 30, net >= 0 ? `+${net}` : `${net}`,
          net >= 0 ? 'var(--green)' : 'var(--red)', 24);
      });
    }
    if (amount >= Config.SHAKE_POT) FX.shake();
    clearPot();
  };
  listeners.onAllInReveal = (entrants) => {
    playSFX('judge');
    FX.banner('决死亮牌', '下注行动结束 · 公开所有在局暗令', 'var(--red)');
    for (const p of entrants) {
      if (p.idx === myIdx) {
        pToks.forEach((token, i) => {
          token.setCard(p.hole[i]);
          token.revealAnim();
        });
      } else {
        seats[p.idx].revealToks.forEach((token, i) => {
          token.setCard(p.hole[i]);
          token.el.style.display = '';
          token.revealAnim();
        });
      }
      setStatus(p.idx, '决死亮牌', 'var(--red)');
    }
  };
  listeners.onShowdown = (data) => {
    const [fx0, fy0] = FX.centerOf(potEl);
    let best = null;
    for (const p of data.entrants) {
      const s = seats[p.idx];
      if (p.idx === myIdx) {
        pToks[0].setCard(p.hole[0]);
        pToks[1].setCard(p.hole[1]);
      } else {
        s.revealToks.forEach((t, i) => {
          t.setCard(p.hole[i]);
          t.el.style.display = '';
        });
      }
      s.handEl.textContent = `✦ ${p.showdownInfo.name} ✦`;
      const won = data.wonAmount[p.idx];
      const net = data.netResult?.[p.idx] ?? (won || 0) - p.betRound;
      const [cx, cy] = FX.centerOf(s.seat);
      if (won && won > 0) {
        FX.potFly(fx0, fy0, cx, cy, () => FX.floatText(
          cx, cy - 34, net >= 0 ? `+${net}` : `${net}`,
          net >= 0 ? 'var(--green)' : 'var(--red)', 26,
        ));
      } else {
        FX.slashFlash(s.seat);
        FX.floatText(cx, cy - 34, `${net}`, 'var(--red)', 22);
      }
      if (!best || p.showdownInfo.score > best.showdownInfo.score) best = p;
    }
    if (best && best.showdownInfo.cat >= 5) {
      FX.banner(best.showdownInfo.name, `${best.hero.name} · ${Config.HAND_NAMES[best.showdownInfo.cat].poker}`);
    }
    if (data.pots?.length > 1) {
      peekEl.textContent = data.pots.map((pot) => {
        const winnersText = pot.winnerIds.map((idx) =>
          `${players[idx].hero.name}净赢${pot.netWinnings?.[idx] ?? 0}`).join('、');
        return `${pot.label} ${pot.amount}（${winnersText}）`;
      }).join(' · ');
    }
    if (data.totalPot >= Config.SHAKE_POT) FX.shake();
    clearPot();
  };
  listeners.onDeath = (idx) => {
    playSFX(players[idx].hero.gender === 'female' ? 'dieFemale' : 'die');
    seats[idx].seat.classList.add('dead');
    FX.deathStamp(seats[idx].seat);
    setStatus(idx, '', '');
  };
  listeners.onRoundEnd = () => {
    for (const [iStr, s] of Object.entries(seats)) {
      if (players[Number(iStr)].alive) s.seat.classList.remove('folded');
    }
  };
  listeners.onGameOver = (ranking) => {
    hideActionUI();
    hideTurnBars();
    engine.delay(2.0, () => onGameOver(ranking));
  };

  // ---- 初始状态 ----
  refreshAll();
  addLog('对局开始：6位英雄入座，初始气血 1500、能量 2⚡', 'sys');
  addLog('提示：鼠标悬停或点击任意武将牌，可查看该英雄的技能详情', 'sys');

  // ---- 每帧驱动 ----
  let skillAcc = 0;
  return {
    tick(dt) {
      // 玩家行动倒计时
      if (awaiting && engine.waitingIdx) {
        timeLeft -= dt;
        timerTxt.textContent = `${Math.max(0, Math.ceil(timeLeft))}s`;
        const pct = Math.max(0, Math.min(1, timeLeft / Config.ACTION_TIME));
        timerBar.style.width = `${Math.floor(pct * 100)}%`;
        timerBar.classList.toggle('low', timeLeft <= 8);
        extendBtn.disabled = me.energy < Config.EXTEND_COST;
        if (timeLeft <= 0) {
          onPlayerAction(lastOpts && lastOpts.canCheck ? { type: 'check' } : { type: 'fold' });
        }
      }
      // 技能面板节流刷新
      skillAcc += dt;
      if (skillAcc >= 0.25) { skillAcc = 0; refreshSkillPanel(); }
      // 座位倒计时条
      if (turnIdx != null && seats[turnIdx]) {
        let pct;
        if (turnIdx === myIdx && awaiting) {
          pct = Math.max(0, Math.min(1, timeLeft / Config.ACTION_TIME));
        } else {
          turnLeft = Math.max(0, turnLeft - dt);
          pct = turnLeft / Config.ACTION_TIME;
        }
        const f = seats[turnIdx].turnFill;
        f.style.width = `${Math.floor(pct * 100)}%`;
        f.classList.toggle('low', pct <= 0.25);
      }
    },
  };
}
