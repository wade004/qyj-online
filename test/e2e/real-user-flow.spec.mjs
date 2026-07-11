import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server/server.mjs';
import { startStaticServer } from '../../scripts/serve-static.mjs';

test.describe.configure({ mode: 'serial' });

let gameServer;
let staticServer;
let wsUrl;
let webUrl;
let databaseDirectory;

test.beforeAll(async () => {
  staticServer = startStaticServer(0, '.');
  await staticServer.ready;
  webUrl = staticServer.url;
  databaseDirectory = await mkdtemp(join(tmpdir(), 'qyj-e2e-player-'));
  gameServer = startServer(0, {
    speed: 40,
    heartbeatMs: 0,
    databasePath: join(databaseDirectory, 'players.sqlite'),
  });
  await gameServer.ready;
  const address = gameServer.wss.address();
  wsUrl = `ws://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await Promise.all([
    staticServer?.close(),
    gameServer?.close(),
  ]);
  if (databaseDirectory) {
    await rm(databaseDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

async function newUser(browser, viewport) {
  const context = await browser.newContext({ viewport, baseURL: webUrl });
  await context.addInitScript((url) => { window.QYJ_WS_URL = url; }, wsUrl);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { context, page, errors };
}

async function enterH5(page) {
  await page.goto('/h5.html');
  await page.getByTestId('h5-enter-landscape').click();
  await expect(page.getByTestId('h5-home')).toBeVisible();
}

async function mountH5FeedbackHarness(page) {
  await page.evaluate(async () => {
    const [{ Engine }, { mountH5Battle }] = await Promise.all([
      import('/js/game/engine.js'),
      import('/js/ui/h5/battle-view.js'),
    ]);
    const root = document.getElementById('app');
    const battle = new Engine(
      ['zhugeliang', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo'],
      {},
      new Set([1]),
      { 1: '反馈测试玩家' },
      { endWhenHumanEliminated: true },
    );
    battle.round = 3;
    battle.players[1].hole = [
      { rank: 14, suit: 1 },
      { rank: 13, suit: 2 },
    ];
    battle.players[1].lastHandCategory = 1;
    battle.players[1].betRound = 80;
    battle.board = [
      { rank: 14, suit: 3 },
      { rank: 7, suit: 4 },
      { rank: 2, suit: 1 },
      { rank: 9, suit: 2 },
      { rank: 4, suit: 3 },
    ];
    battle.revealed = 0;

    const events = [];
    const snapshot = (node) => {
      if (!(node instanceof Element)) return;
      const candidates = [node, ...node.querySelectorAll?.('[data-testid], .h5-card.is-combo') || []];
      for (const candidate of candidates) {
        const testId = candidate.getAttribute('data-testid');
        const comboCard = candidate.classList.contains('h5-card')
          && candidate.classList.contains('is-combo');
        if (!testId && !comboCard) continue;
        events.push({
          id: testId || 'h5-combo-card',
          text: candidate.textContent?.trim() || '',
          className: candidate.className,
          outcome: candidate.getAttribute('data-outcome') || '',
          ariaLive: candidate.getAttribute('aria-live') || '',
        });
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        snapshot(record.target);
        for (const added of record.addedNodes) snapshot(added);
      }
    });
    observer.observe(root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
      attributeFilter: ['class', 'data-outcome', 'aria-live'],
    });

    const view = mountH5Battle({
      root,
      battle,
      myIdx: 1,
      online: false,
      onGameOver: () => {},
    });
    window.__h5FeedbackHarness = { battle, events, observer, view };
  });
  await expect(page.getByTestId('h5-battle')).toBeVisible();
}

async function h5FeedbackEvents(page, id) {
  return page.evaluate((wantedId) => (
    window.__h5FeedbackHarness?.events.filter((event) => event.id === wantedId) || []
  ), id);
}

async function h5CardArtworkReport(page) {
  return page.evaluate(async () => {
    const cssImageUrls = (value) => [...value.matchAll(/url\(["']?([^"')]+)["']?\)/gu)]
      .map((match) => new URL(match[1], document.baseURI).href);
    const loadImage = (source) => new Promise((resolve) => {
      const image = new Image();
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        resolve({ source, loaded, width: image.naturalWidth, height: image.naturalHeight });
      };
      image.addEventListener('load', () => finish(image.naturalWidth > 0 && image.naturalHeight > 0), { once: true });
      image.addEventListener('error', () => finish(false), { once: true });
      image.src = source;
      if (image.complete) queueMicrotask(() => finish(image.naturalWidth > 0 && image.naturalHeight > 0));
    });
    const artwork = async (element) => {
      const backgroundImages = [
        getComputedStyle(element).backgroundImage,
        getComputedStyle(element, '::before').backgroundImage,
        getComputedStyle(element, '::after').backgroundImage,
      ];
      const sources = [...new Set(backgroundImages.flatMap(cssImageUrls))];
      return {
        backgroundImage: backgroundImages.join(' | '),
        sources,
        images: await Promise.all(sources.map(loadImage)),
      };
    };

    const hiddenBacks = [...document.querySelectorAll('.h5-card.is-face-up .h5-card__back')]
      .map((back) => ({ hidden: back.hidden, display: getComputedStyle(back).display }));
    const backs = await Promise.all(
      [...document.querySelectorAll('.h5-card--board:not(.is-face-up) .h5-card__back:not([hidden])')]
        .map(async (back) => {
          const card = back.closest('.h5-card');
          const cardRect = card.getBoundingClientRect();
          const backRect = back.getBoundingClientRect();
          return {
            ...(await artwork(back)),
            visible: backRect.width > 0 && backRect.height > 0
              && getComputedStyle(back).visibility === 'visible'
              && Number(getComputedStyle(back).opacity) > 0,
            coverage: (backRect.width * backRect.height) / (cardRect.width * cardRect.height),
          };
        }),
    );
    const faces = await Promise.all(
      [...document.querySelectorAll('.h5-card.is-face-up')].map(async (card) => {
        const suit = card.querySelector('img.h5-card__suit');
        const suitRect = suit?.getBoundingClientRect();
        const suitStyle = suit ? getComputedStyle(suit) : null;
        const suitSource = suit?.currentSrc || suit?.src || '';
        const suitAsset = suitSource ? await loadImage(suitSource) : null;
        return {
          ...(await artwork(card)),
          ariaLabel: card.getAttribute('aria-label')?.trim() || '',
          suit: {
            exists: Boolean(suit),
            source: suitSource,
            hidden: suit?.hidden ?? true,
            visible: Boolean(suitRect?.width && suitRect?.height)
              && suitStyle?.display !== 'none'
              && suitStyle?.visibility === 'visible'
              && Number(suitStyle?.opacity) > 0,
            asset: suitAsset,
          },
        };
      }),
    );
    return { backs, faces, hiddenBacks };
  });
}

async function clickWhenReady(locator) {
  try {
    if (!await locator.isEnabled({ timeout: 250 })) return false;
    await locator.click({ timeout: 750 });
    return true;
  } catch {
    // The authoritative server may advance the turn between the enabled check
    // and the click. That race is expected; retry on the next polling cycle.
    return false;
  }
}

async function closeContext(context) {
  await Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function roomMemberSnapshot(page, platform) {
  return page.getByTestId(`${platform}-room-member`).evaluateAll((nodes, prefix) => {
    const read = (node, suffix) => node
      .querySelector(`[data-testid="${prefix}-room-member-${suffix}"]`)
      ?.textContent?.trim() || '';
    return nodes.map((node) => {
      const rawId = read(node, 'id');
      const idMatch = rawId.match(/#([A-Za-z0-9_-]{4,16})/u);
      return {
        name: read(node, 'name'),
        id: idMatch?.[1] || '',
        emblem: read(node, 'emblem'),
        isYou: node.dataset.isYou === 'true',
        isOwner: node.dataset.owner === 'true',
      };
    });
  }, platform);
}

async function expectPokerStatsPanel(panel, prefix) {
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/近\s*30\s*天\s*·\s*最近\s*200\s*手/u);
  for (const metric of ['vpip', 'pfr', 'threebet', 'af', 'hands']) {
    await expect(panel.getByTestId(`${prefix}-${metric}`)).toBeVisible();
  }
}

async function pokerHandsValue(metric) {
  const text = await metric.locator('strong').textContent();
  const value = Number(String(text || '').replace(/[^\d.]/gu, ''));
  return Number.isFinite(value) ? value : -1;
}

async function closePokerStatsPanel(page, panel) {
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}

function unexpectedBrowserErrors(users, { allowOfflineNetworkErrors = false } = {}) {
  const errors = users.flatMap((user) => user.errors);
  if (!allowOfflineNetworkErrors) return errors;
  return errors.filter((message) => !(
    /WebSocket connection .* failed/i.test(message)
    || /ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED)/i.test(message)
  ));
}

async function pcBattleLayoutReport(page) {
  return page.getByTestId('pc-battle').evaluate((root) => {
    const fit = root.closest('[data-testid="pc-battle-fit"]');
    const rootRect = root.getBoundingClientRect();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
    };
    const geometry = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: element.dataset.testid || element.className,
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        inside: rect.left >= rootRect.left - 1 && rect.top >= rootRect.top - 1
          && rect.right <= rootRect.right + 1 && rect.bottom <= rootRect.bottom + 1,
      };
    };
    const overlapArea = (left, right) => {
      if (!left || !right) return 0;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    };
    const critical = [...root.querySelectorAll(
      '.topbar,.logpanel,.seat-wrap,.board-cards,.bb-skill,.bb-hand .hand-cards,.bb-right .btn-grid',
    )].filter(visible).map(geometry);
    const actions = [...root.querySelectorAll('[data-testid^="pc-action-"]')]
      .filter(visible)
      .map((element) => {
        const item = geometry(element);
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return { ...item, hit: hit === element || element.contains(hit) };
      });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scale: Number(fit?.dataset.scale || 1),
      root: geometry(root),
      overflowX: root.scrollWidth - root.clientWidth,
      overflowY: root.scrollHeight - root.clientHeight,
      critical,
      actions,
      counts: {
        seats: root.querySelectorAll('.seat-wrap').length,
        board: root.querySelectorAll('.board-cards .card-board').length,
        hand: root.querySelectorAll('.bb-hand .card-hand').length,
      },
      overlaps: {
        boardBottom: overlapArea(root.querySelector('.board-cards'), root.querySelector('.bottombar')),
        logTable: Math.max(0, ...[...root.querySelectorAll('.seat-wrap,.board-cards')]
          .map((element) => overlapArea(root.querySelector('.logpanel'), element))),
        meSkill: overlapArea(root.querySelector('.bb-me .seat-wrap'), root.querySelector('.bb-skill')),
        skillHand: overlapArea(root.querySelector('.bb-skill'), root.querySelector('.bb-hand .hand-cards')),
        handActions: overlapArea(root.querySelector('.bb-hand .hand-cards'), root.querySelector('.bb-right .btn-grid')),
      },
    };
  });
}

async function h5BattleControlReport(page) {
  return page.getByTestId('h5-battle').evaluate((battle) => {
    const audio = document.querySelector('[data-testid="h5-audio-toggle"]');
    const topbar = battle.querySelector('.h5-battle__topbar');
    const dock = battle.querySelector('.h5-battle__dock');
    const actions = battle.querySelector('.h5-actions');
    const seat = battle.querySelector('.h5-seat');
    const boardCard = battle.querySelector('.h5-card--board');
    const board = battle.querySelector('.h5-board');
    const actionButton = battle.querySelector('[data-testid="h5-action-call"]');
    const advisorToggle = battle.querySelector('[data-testid="h5-advisor-toggle"]');
    const gto = battle.querySelector('[data-testid="h5-gto-advice"]');
    const gtoReason = battle.querySelector('[data-testid="h5-gto-reason"]');
    const gtoMetrics = battle.querySelector('[data-testid="h5-gto-metrics"]');
    const strength = battle.querySelector('[data-testid="h5-hand-strength"]');
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      } : null;
    };
    const overlapArea = (left, right) => {
      if (!left || !right) return 0;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    };
    const audioRect = rect(audio);
    const hit = audioRect && document.elementFromPoint(
      audioRect.left + audioRect.width / 2,
      audioRect.top + audioRect.height / 2,
    );
    const hitReport = (element) => {
      const box = rect(element);
      if (!box) return null;
      const target = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        ...box,
        inside: box.left >= -1 && box.top >= -1
          && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
        hit: target === element || element.contains(target),
      };
    };
    const textReport = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        fullyVisible: element.scrollWidth <= element.clientWidth + 1
          && element.scrollHeight <= element.clientHeight + 1,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      audio: audioRect,
      topbar: rect(topbar),
      dock: rect(dock),
      actions: rect(actions),
      seat: rect(seat),
      boardCard: rect(boardCard),
      actionButton: rect(actionButton),
      gto: rect(gto),
      strength: rect(strength),
      gtoReason: textReport(gtoReason),
      gtoMetrics: textReport(gtoMetrics),
      uiScale: Number(document.getElementById('h5-ui')?.dataset.uiScale || 1),
      advisorToggle: hitReport(advisorToggle),
      actionTargets: [...battle.querySelectorAll('[data-testid^="h5-action-"]')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && box.width > 0 && box.height > 0;
        })
        .map(hitReport),
      audioHit: Boolean(audio && (hit === audio || audio.contains(hit))),
      overlapDock: overlapArea(audio, dock),
      overlapActions: overlapArea(audio, actions),
      overlapHeaderControls: Math.max(0, ...[...topbar.querySelectorAll('button, label')]
        .map((element) => overlapArea(audio, element))),
      overlapGtoBoard: overlapArea(gto, board),
      overlapStrengthActions: overlapArea(strength, actions),
      overlapGtoDock: overlapArea(gto, dock),
    };
  });
}

test('平台入口隔离：PC 窄屏不变 H5，H5 竖屏只显示阻断层', async ({ browser }) => {
  const pc = await newUser(browser, { width: 390, height: 844 });
  await pc.page.goto('/index.html');
  await expect(pc.page.getByTestId('pc-mode-online')).toBeVisible();
  await expect(pc.page.getByText('请将手机横置')).toHaveCount(0);
  await pc.context.close();

  const h5 = await newUser(browser, { width: 390, height: 844 });
  await h5.page.goto('/h5.html');
  await expect(h5.page.getByRole('dialog', { name: '横屏进入《群英决》' })).toBeVisible();
  await h5.page.getByTestId('h5-enter-landscape').click();
  await expect(h5.page.getByRole('dialog', { name: '请将手机横置' })).toBeVisible();
  await expect(h5.page.getByTestId('h5-home')).not.toBeVisible();
  await expect(h5.page.locator('#h5-stage')).toHaveJSProperty('inert', true);
  await h5.page.setViewportSize({ width: 844, height: 390 });
  await expect(h5.page.getByTestId('h5-home')).toBeVisible();
  await expect(h5.page.locator('#h5-stage')).toHaveJSProperty('inert', false);
  await h5.page.setViewportSize({ width: 568, height: 320 });
  await expect(h5.page.getByTestId('h5-home')).toBeVisible();
  await h5.page.setViewportSize({ width: 567, height: 320 });
  await expect(h5.page.getByRole('dialog', { name: '当前屏幕尺寸过小' })).toBeVisible();
  await h5.page.setViewportSize({ width: 667, height: 375 });
  await expect(h5.page.getByTestId('h5-home')).toBeVisible();
  expect(unexpectedBrowserErrors([pc, h5])).toEqual([]);
  await h5.context.close();
});

test('PC 小屏对局自动适配：核心区域不裁切、不重叠且操作可达', async ({ browser }) => {
  const user = await newUser(browser, { width: 1440, height: 900 });
  try {
    await user.page.goto('/index.html');
    await user.page.getByTestId('pc-mode-single').click();
    await user.page.locator('.hero-card').first().click();
    await expect(user.page.getByTestId('pc-battle')).toBeVisible();

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 640 },
      { width: 844, height: 390 },
    ]) {
      await user.page.setViewportSize(viewport);
      await user.page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const report = await pcBattleLayoutReport(user.page);
      const details = JSON.stringify(report, null, 2);
      const expectedScale = Math.min(1, viewport.width / 1320, viewport.height / 900);

      expect(report.scale, details).toBeCloseTo(expectedScale, 3);
      expect(report.root.left, details).toBeGreaterThanOrEqual(-1);
      expect(report.root.top, details).toBeGreaterThanOrEqual(-1);
      expect(report.root.right, details).toBeLessThanOrEqual(viewport.width + 1);
      expect(report.root.bottom, details).toBeLessThanOrEqual(viewport.height + 1);
      expect(report.root.width, details).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(report.root.height, details).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(report.overflowX, details).toBeLessThanOrEqual(1);
      expect(report.overflowY, details).toBeLessThanOrEqual(1);
      expect(report.counts, details).toEqual({ seats: 6, board: 5, hand: 2 });
      expect(report.critical.every((item) => item.inside), details).toBe(true);
      expect(report.actions.length, details).toBeGreaterThanOrEqual(3);
      expect(report.actions.every((item) => item.inside && item.hit), details).toBe(true);
      expect(Math.min(...report.actions.map((item) => item.width)), details).toBeGreaterThanOrEqual(60);
      expect(Math.min(...report.actions.map((item) => item.height)), details).toBeGreaterThanOrEqual(20);
      expect(Object.values(report.overlaps).every((area) => area <= 1), details).toBe(true);

      await user.page.getByTestId('pc-battle').evaluate((root) => root.classList.add('shake'));
      await user.page.waitForTimeout(80);
      const shakeWidth = await user.page.getByTestId('pc-battle').evaluate(
        (root) => root.getBoundingClientRect().width,
      );
      expect(shakeWidth).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(shakeWidth).toBeLessThanOrEqual(viewport.width + 1);
      await user.page.getByTestId('pc-battle').evaluate((root) => root.classList.remove('shake'));
    }
    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await closeContext(user.context);
  }
});

test('H5 单机真实用户烟测：顶部声音、568×320 操作与只读 GTO 辅助均可用', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  try {
    await enterH5(user.page);
    await expect(user.page.getByTestId('h5-audio-toggle')).toBeVisible();
    await user.page.getByTestId('h5-mode-single').click();
    await expect(user.page.getByTestId('h5-single-pick')).toBeVisible();
    await user.page.getByTestId('h5-hero-zhugeliang').click();

    await user.page.evaluate(() => {
      window.__h5ActionClickCount = 0;
      document.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-testid^="h5-action-"]')) {
          window.__h5ActionClickCount += 1;
        }
      }, true);
    });
    await user.page.getByTestId('h5-confirm-hero').click();
    await expect(user.page.getByTestId('h5-battle')).toBeVisible();
    await expect(user.page.getByTestId('h5-action-call')).toBeAttached();
    await expect(user.page.locator('.h5-card--hand.is-face-up .h5-card__back:visible')).toHaveCount(0);

    const advisorToggle = user.page.getByTestId('h5-advisor-toggle');
    await expect(advisorToggle).toBeVisible();
    await expect(advisorToggle).toBeChecked();
    // A round can end uncontested before seat 1 is asked to act. Wait across
    // that valid round transition instead of assuming every deal reaches us.
    await expect(user.page.getByTestId('h5-action-call')).toBeEnabled({ timeout: 45_000 });
    const advice = user.page.getByTestId('h5-gto-advice');
    const strength = user.page.getByTestId('h5-hand-strength');
    const strengthValue = user.page.getByTestId('h5-hand-strength-value');
    const strengthGrade = user.page.getByTestId('h5-hand-strength-grade');
    await expect(advice).toBeVisible();
    await expect(strength).toBeVisible();
    await expect(strengthValue).toHaveText(/^\d{1,3}%$/u);
    await expect(strengthGrade).toHaveText(/^(劣势|胶着|优势|碾压)$/u);
    const strengthPercent = Number((await strengthValue.textContent()).replace('%', ''));
    expect(strengthPercent).toBeGreaterThanOrEqual(0);
    expect(strengthPercent).toBeLessThanOrEqual(100);
    expect(await strength.locator('.h5-hand-strength__fill').evaluate((fill) => fill.style.width))
      .toBe(`${strengthPercent}%`);
    await expect(strength).toHaveAttribute('aria-valuenow', String(strengthPercent));
    await expect(user.page.locator('.h5-battle__timer')).toHaveCount(0);
    await expect(user.page.getByTestId('h5-gto-recommendation')).toHaveText(/\S/u);
    await expect(user.page.getByTestId('h5-gto-reason')).toHaveText(/\S/u);
    await expect(user.page.getByTestId('h5-gto-metrics')).toHaveText(/\S/u);
    await advisorToggle.uncheck();
    await expect(advice).toBeHidden();
    await expect(strength, '关闭 GTO 辅助后实时牌力仍应保留').toBeVisible();
    await expect(strengthValue).toHaveText(`${strengthPercent}%`);
    await advisorToggle.check();
    await expect(advice).toBeVisible();

    // The advisor is informational only: waiting must not click or submit an
    // action on the player's behalf. The same action remains available until
    // this test explicitly chooses one.
    await user.page.waitForTimeout(600);
    expect(await user.page.evaluate(() => window.__h5ActionClickCount)).toBe(0);
    await expect(user.page.getByTestId('h5-action-call')).toBeEnabled();

    const responsiveReports = [];
    for (const viewport of [
      { width: 568, height: 320 },
      { width: 844, height: 390 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ]) {
      await user.page.setViewportSize(viewport);
      await user.page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await expect(user.page.getByTestId('h5-battle')).toBeVisible();
      await expect(user.page.getByTestId('h5-action-call')).toBeVisible();
      const report = await h5BattleControlReport(user.page);
      responsiveReports.push(report);
      const details = JSON.stringify(report, null, 2);
      expect(report.audio, details).not.toBeNull();
      expect(report.topbar, details).not.toBeNull();
      expect(report.audio.left, details).toBeGreaterThanOrEqual(-1);
      expect(report.audio.top, details).toBeGreaterThanOrEqual(-1);
      expect(report.audio.right, details).toBeLessThanOrEqual(viewport.width + 1);
      expect(report.audio.bottom, details).toBeLessThanOrEqual(report.topbar.bottom + 1);
      expect(report.audioHit, details).toBe(true);
      expect(report.advisorToggle?.inside && report.advisorToggle?.hit, details).toBe(true);
      expect(report.actionTargets.length, details).toBeGreaterThanOrEqual(3);
      expect(report.actionTargets.every((target) => target.inside && target.hit), details).toBe(true);
      expect(report.strength, details).not.toBeNull();
      expect(report.strength.left, details).toBeGreaterThanOrEqual(-1);
      expect(report.strength.right, details).toBeLessThanOrEqual(viewport.width + 1);
      expect(report.overlapDock, details).toBeLessThanOrEqual(1);
      expect(report.overlapActions, details).toBeLessThanOrEqual(1);
      expect(report.overlapHeaderControls, details).toBeLessThanOrEqual(1);
      expect(report.overlapStrengthActions, details).toBeLessThanOrEqual(1);
      expect(report.gtoReason?.text, details).toMatch(/^理由：\S/u);
      expect(report.gtoMetrics?.text, details).toMatch(/^胜算\s*\d/u);
      expect(report.gtoReason?.whiteSpace, details).not.toBe('nowrap');
      expect(report.gtoMetrics?.whiteSpace, details).not.toBe('nowrap');
      expect(report.gtoReason?.textOverflow, details).not.toBe('ellipsis');
      expect(report.gtoMetrics?.textOverflow, details).not.toBe('ellipsis');
      expect(report.gtoReason?.fullyVisible, details).toBe(true);
      expect(report.gtoMetrics?.fullyVisible, details).toBe(true);
      expect(report.overlapGtoBoard, details).toBeLessThanOrEqual(1);
      expect(report.overlapGtoDock, details).toBeLessThanOrEqual(1);
    }

    const compact = responsiveReports[0];
    const baseline = responsiveReports[1];
    const desktop = responsiveReports[2];
    const fullHd = responsiveReports[3];
    expect(compact.uiScale).toBeCloseTo(1, 2);
    expect(baseline.uiScale).toBeCloseTo(1, 2);
    expect(desktop.uiScale).toBeCloseTo(1366 / 844, 2);
    expect(fullHd.uiScale).toBeCloseTo(1920 / 844, 2);
    for (const key of ['seat', 'boardCard', 'actionButton']) {
      expect(desktop[key].width, `${key} 应在 1366 横屏连续放大`)
        .toBeGreaterThan(baseline[key].width * 1.5);
      expect(fullHd[key].width, `${key} 应在 1920 横屏继续放大`)
        .toBeGreaterThan(desktop[key].width * 1.3);
    }

    expect(await clickWhenReady(user.page.getByTestId('h5-action-call'))).toBe(true);
    expect(await user.page.evaluate(() => window.__h5ActionClickCount)).toBe(1);

    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await closeContext(user.context);
  }
});

test('H5 卡牌视觉：暗牌背面与明牌底纹在两档横屏均完整显示', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);

    for (const viewport of [
      { width: 844, height: 390 },
      { width: 568, height: 320 },
    ]) {
      await user.page.setViewportSize(viewport);
      await user.page.evaluate(() => {
        const { battle } = window.__h5FeedbackHarness;
        battle.revealed = 0;
        battle.listeners.onRoundStart?.(battle.round, { sb: 10, bb: 20 }, 1);
      });
      await expect(user.page.locator('.h5-card--board:not(.is-face-up) .h5-card__back:visible'))
        .toHaveCount(5);

      const faceDown = await h5CardArtworkReport(user.page);
      const viewportLabel = `${viewport.width}x${viewport.height}`;
      expect(faceDown.backs, `${viewportLabel} 的五张暗牌都应显示背面`).toHaveLength(5);
      expect(
        faceDown.backs.every((card) => card.visible && card.coverage >= 0.8),
        `${viewportLabel} 的牌背应覆盖完整牌面：${JSON.stringify(faceDown.backs)}`,
      ).toBe(true);
      expect(
        faceDown.backs.every((card) => card.sources.length > 0
          && card.images.every((image) => image.loaded && image.width > 0 && image.height > 0)),
        `${viewportLabel} 的牌背应使用可成功加载的图片资源：${JSON.stringify(faceDown.backs)}`,
      ).toBe(true);
      const backSources = new Set(faceDown.backs.flatMap((card) => card.sources));

      await user.page.evaluate(() => {
        const { battle } = window.__h5FeedbackHarness;
        battle.revealed = 5;
        battle.listeners.onStreet?.('river', 5);
      });
      await expect(user.page.locator('.h5-card--board.is-face-up')).toHaveCount(5);

      const faceUp = await h5CardArtworkReport(user.page);
      expect(faceUp.faces, `${viewportLabel} 应展示五张公共牌与两张手牌`).toHaveLength(7);
      expect(
        faceUp.faces.every((card) => /(?:10|[2-9JQKA])/u.test(card.ariaLabel)
          && /[♠♥♦♣]/u.test(card.ariaLabel)),
        `${viewportLabel} 的每张明牌都应通过 aria-label 提供点数和花色：${JSON.stringify(faceUp.faces)}`,
      ).toBe(true);
      expect(
        faceUp.faces.every((card) => card.suit.exists
          && card.suit.source
          && !card.suit.hidden
          && card.suit.visible
          && card.suit.asset?.loaded
          && card.suit.asset.width > 0
          && card.suit.asset.height > 0),
        `${viewportLabel} 的每张明牌都应显示可成功加载的花色图片：${JSON.stringify(faceUp.faces)}`,
      ).toBe(true);
      expect(
        faceUp.faces.every((card) => card.sources.length > 0
          && card.images.every((image) => image.loaded && image.width > 0 && image.height > 0)),
        `${viewportLabel} 的每张明牌都应保留可加载的纸张底纹：${JSON.stringify(faceUp.faces)}`,
      ).toBe(true);
      const faceSources = new Set(faceUp.faces.flatMap((card) => card.sources));
      expect(
        [...backSources].some((source) => !faceSources.has(source))
          && [...faceSources].some((source) => !backSources.has(source)),
        `${viewportLabel} 的牌背图与明牌底纹不应是同一资源：${JSON.stringify({
          backSources: [...backSources],
          faceSources: [...faceSources],
        })}`,
      ).toBe(true);
      expect(faceUp.hiddenBacks, `${viewportLabel} 明牌背面层数量异常`).toHaveLength(7);
      expect(
        faceUp.hiddenBacks.every((back) => back.hidden && back.display === 'none'),
        `${viewportLabel} 明牌不能被背面层覆盖：${JSON.stringify(faceUp.hiddenBacks)}`,
      ).toBe(true);
    }

    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await closeContext(user.context);
  }
});

test('H5 座位状态：每名玩家持续展示等待、行动、退避、决死与阵亡状态', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  const statusFor = (idx) => user.page.getByTestId(`h5-seat-status-${idx}`);
  const opponentTurnLayout = (idx) => statusFor(idx).evaluate((status) => {
    const seat = status.closest('.h5-seat');
    const portrait = seat?.querySelector('.h5-seat__portrait');
    const timer = status.querySelector('.h5-player-status__timer');
    const statusRect = status.getBoundingClientRect();
    const seatRect = seat?.getBoundingClientRect();
    const timerRect = timer?.getBoundingClientRect();
    const overlapArea = (left, right) => {
      if (!left || !right) return 0;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    };
    return {
      position: getComputedStyle(status).position,
      insideSeat: Boolean(seatRect)
        && statusRect.left >= seatRect.left - 1
        && statusRect.right <= seatRect.right + 1
        && statusRect.top >= seatRect.top - 1
        && statusRect.bottom <= seatRect.bottom + 1,
      statusWidthRatio: seatRect?.width ? statusRect.width / seatRect.width : 0,
      footerGapRatio: seatRect?.height ? (seatRect.bottom - statusRect.bottom) / seatRect.height : 1,
      portraitOverlap: overlapArea(status, portrait),
      hasCountdown: status.classList.contains('has-countdown'),
      isLow: status.classList.contains('is-countdown-low'),
      remaining: Number(status.dataset.remaining),
      progress: Number(status.dataset.progress),
      statusAnimation: getComputedStyle(status).animationName,
      timerDisplay: timer ? getComputedStyle(timer).display : '',
      timerAnimation: timer ? getComputedStyle(timer).animationName : '',
      timerWidthRatio: statusRect.width ? (timerRect?.width || 0) / statusRect.width : 0,
    };
  });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.street = 'preflop';
      battle.revealed = 0;
      for (const player of battle.players.slice(1)) {
        player.alive = true;
        player.folded = false;
        player.allIn = false;
        player.acted = false;
        player.betStreet = 0;
        player.lastActionBet = 0;
      }
      battle.listeners.onRoundStart?.(battle.round, { sb: 10, bb: 20 }, 6);
    });

    await expect(user.page.locator('[data-testid^="h5-seat-status-"]')).toHaveCount(6);
    for (let idx = 1; idx <= 6; idx++) {
      await expect(statusFor(idx), `座位 ${idx} 开局应提示尚未行动`)
        .toHaveAttribute('data-state', 'idle');
      await expect(statusFor(idx)).toContainText('尚未行动');
    }

    await user.page.evaluate(() => {
      window.__h5FeedbackHarness.battle.listeners.onTurnStart?.(2);
    });
    await expect(statusFor(2)).toHaveAttribute('data-state', 'turn');
    await expect(statusFor(2)).toContainText('轮到行动 · 30s');
    await expect(statusFor(1)).toHaveAttribute('data-state', 'waiting');
    await expect(statusFor(1)).toContainText('等待他人');

    for (const viewport of [
      { width: 568, height: 320 },
      { width: 844, height: 390 },
      { width: 1920, height: 1080 },
    ]) {
      await user.page.setViewportSize(viewport);
      await user.page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const layout = await opponentTurnLayout(2);
      const details = `${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`;
      expect(layout.position, details).toBe('absolute');
      expect(layout.insideSeat, details).toBe(true);
      expect(layout.statusWidthRatio, details).toBeGreaterThan(.82);
      expect(layout.footerGapRatio, details).toBeGreaterThanOrEqual(0);
      expect(layout.footerGapRatio, details).toBeLessThan(.12);
      expect(layout.portraitOverlap, details).toBeLessThanOrEqual(1);
      expect(layout.hasCountdown, details).toBe(true);
      expect(layout.remaining, details).toBe(30);
      expect(layout.progress, details).toBe(100);
      expect(layout.timerDisplay, details).toBe('block');
      expect(layout.timerAnimation, details).toBe('none');
      expect(layout.timerWidthRatio, details).toBeGreaterThan(.96);
    }
    await user.page.setViewportSize({ width: 844, height: 390 });

    await user.page.evaluate(() => window.__h5FeedbackHarness.view.tick(10));
    await expect.poll(async () => (await opponentTurnLayout(2)).timerWidthRatio, {
      message: '其他玩家的行动条应从30秒持续缩短到20秒，而不是来回滑动',
      timeout: 2_000,
    }).toBeLessThan(.71);
    const opponentMiddle = await opponentTurnLayout(2);
    expect(opponentMiddle.remaining).toBe(20);
    expect(opponentMiddle.progress).toBeCloseTo(66.67, 1);
    expect(opponentMiddle.timerWidthRatio).toBeGreaterThan(.62);
    await expect(statusFor(2)).toContainText('轮到行动 · 20s');

    await user.page.evaluate(() => window.__h5FeedbackHarness.view.tick(15));
    const opponentUrgent = await opponentTurnLayout(2);
    expect(opponentUrgent.remaining).toBe(5);
    expect(opponentUrgent.isLow).toBe(true);
    expect(opponentUrgent.statusAnimation).toContain('h5-countdown-danger');
    await expect(statusFor(2)).toContainText('轮到行动 · 5s');

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.players[2].acted = true;
      battle.listeners.onAction?.(2, 'check', 0);
      battle.listeners.onTurnStart?.(3);
    });
    await expect(statusFor(2)).toHaveAttribute('data-state', 'acted');
    await expect(statusFor(2)).toContainText('静观');
    await expect(statusFor(3)).toHaveAttribute('data-state', 'turn');
    await expect(statusFor(3)).toContainText('轮到行动');

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.players[3].acted = true;
      battle.players[3].betStreet = 80;
      battle.listeners.onAction?.(3, 'call', 80);
      battle.listeners.onTurnStart?.(4);
      battle.players[4].acted = true;
      battle.players[4].betStreet = 120;
      battle.listeners.onAction?.(4, 'feint', 120);
    });
    await user.page.setViewportSize({ width: 568, height: 320 });
    const compactStatusLayout = await user.page
      .locator('[data-testid^="h5-seat-status-"]')
      .evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.getAttribute('data-testid'),
          text: node.textContent,
          visible: rect.width > 0 && rect.height > 0,
          clipped: node.scrollWidth > node.clientWidth,
        };
      }));
    expect(compactStatusLayout).toHaveLength(6);
    expect(
      compactStatusLayout.every((status) => status.visible && !status.clipped),
      `568×320 下每个状态及操作数值都应完整可见：${JSON.stringify(compactStatusLayout)}`,
    ).toBe(true);
    await expect(statusFor(3)).toHaveAttribute('data-state', 'acted');
    await expect(statusFor(3)).toContainText(/应战\s*80/u);
    await expect(statusFor(4)).toHaveAttribute('data-state', 'acted');
    await expect(statusFor(4)).toContainText(/佯攻\s*120/u);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.listeners.onTurnStart?.(5);
      battle.players[5].folded = true;
      battle.players[5].acted = true;
      battle.listeners.onAction?.(5, 'fold', 0);
      battle.listeners.onTurnStart?.(6);
      battle.players[6].allIn = true;
      battle.players[6].acted = true;
      battle.players[6].betStreet = 300;
      battle.listeners.onAction?.(6, 'allin', 300);
    });
    await expect(statusFor(5)).toHaveAttribute('data-state', 'folded');
    await expect(statusFor(5)).toContainText('退避');
    await expect(statusFor(6)).toHaveAttribute('data-state', 'allin');
    await expect(statusFor(6)).toContainText(/决死\s*300/u);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.street = 'flop';
      battle.revealed = 3;
      for (const player of battle.players.slice(1)) {
        if (!player.folded && !player.allIn && player.alive) {
          player.acted = false;
          player.betStreet = 0;
          player.lastActionBet = 0;
        }
      }
      battle.listeners.onStreet?.('flop', 3);
    });
    await expect(statusFor(2), '进入下一条街后，普通玩家应恢复尚未行动')
      .toHaveAttribute('data-state', 'idle');
    await expect(statusFor(2)).toContainText('尚未行动');
    await expect(statusFor(5), '退避状态应持续到本回合结束')
      .toHaveAttribute('data-state', 'folded');
    await expect(statusFor(5)).toContainText('退避');
    await expect(statusFor(6), '决死状态应跨街持续显示')
      .toHaveAttribute('data-state', 'allin');
    await expect(statusFor(6)).toContainText(/决死/u);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.players[6].alive = false;
      battle.players[6].hp = 0;
      battle.players[6].deathRound = battle.round;
      battle.listeners.onDeath?.(6);
    });
    await expect(statusFor(6), '阵亡应覆盖先前的决死状态')
      .toHaveAttribute('data-state', 'dead');
    await expect(statusFor(6)).toContainText('阵亡');

    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await user.page.evaluate(() => {
      window.__h5FeedbackHarness?.observer?.disconnect();
      window.__h5FeedbackHarness?.view?.destroy?.();
      delete window.__h5FeedbackHarness;
    }).catch(() => {});
    await closeContext(user.context);
  }
});

test('H5 行动倒计时：状态条持续缩短且最后5秒红色闪烁', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  const countdownReport = () => user.page.evaluate(() => {
    const status = document.querySelector('[data-testid="h5-seat-status-1"]');
    const statusFill = status?.querySelector('.h5-player-status__timer');
    const strength = document.querySelector('[data-testid="h5-hand-strength"]');
    const strengthValue = document.querySelector('[data-testid="h5-hand-strength-value"]');
    const strengthGrade = document.querySelector('[data-testid="h5-hand-strength-grade"]');
    const statusRect = status?.getBoundingClientRect();
    const statusFillRect = statusFill?.getBoundingClientRect();
    return {
      label: status?.textContent || '',
      remaining: Number(status?.dataset.remaining),
      progress: Number(status?.dataset.progress),
      statusFillRatio: statusRect?.width
        ? statusFillRect.width / statusRect.width
        : 0,
      statusLow: status?.classList.contains('is-countdown-low'),
      statusAnimation: getComputedStyle(status).animationName,
      oldBottomTimerCount: document.querySelectorAll('.h5-battle__timer').length,
      strengthText: strength?.textContent || '',
      strengthValue: strengthValue?.textContent || '',
      strengthGrade: strengthGrade?.textContent || '',
      strengthAria: strength?.hasAttribute('aria-valuenow')
        ? Number(strength.getAttribute('aria-valuenow'))
        : null,
    };
  });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);
    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      const me = battle.players[1];
      battle.street = 'preflop';
      battle.actingIdx = 1;
      battle.waitingIdx = 1;
      battle.listeners.onTurnStart?.(1);
      battle.listeners.onAwaitAction?.(1, battle.getOptions(me), 30);
    });
    await user.page.waitForTimeout(180);
    const start = await countdownReport();
    expect(start.label).toContain('轮到行动 · 30s');
    expect(start.remaining).toBe(30);
    expect(start.progress).toBe(100);
    expect(start.statusFillRatio).toBeGreaterThan(.96);
    expect(start.oldBottomTimerCount).toBe(0);
    expect(start.strengthText).not.toMatch(/\d+s/u);
    expect(start.strengthValue).toMatch(/^\d{1,3}%$/u);
    expect(start.strengthGrade).toMatch(/^(劣势|胶着|优势|碾压)$/u);
    expect(start.strengthAria).toBeGreaterThanOrEqual(0);
    expect(start.strengthAria).toBeLessThanOrEqual(100);

    await user.page.evaluate(() => window.__h5FeedbackHarness.view.tick(10));
    await expect.poll(async () => (await countdownReport()).statusFillRatio, {
      message: '状态条视觉进度应跟随 66.67% 数据进度完成过渡',
      timeout: 2_000,
    }).toBeLessThan(.71);
    const middle = await countdownReport();
    expect(middle.label).toContain('20s');
    expect(middle.progress).toBeCloseTo(66.67, 1);
    expect(middle.statusFillRatio).toBeGreaterThan(.62);
    expect(middle.statusFillRatio).toBeLessThan(.71);
    expect(middle.strengthValue).toBe(start.strengthValue);

    await user.page.evaluate(() => window.__h5FeedbackHarness.view.tick(15.1));
    await user.page.waitForTimeout(80);
    const urgent = await countdownReport();
    expect(urgent.label).toContain('轮到行动 · 5s');
    expect(urgent.remaining).toBe(5);
    expect(urgent.statusLow).toBe(true);
    expect(urgent.statusAnimation).toContain('h5-countdown-danger');
    expect(urgent.strengthValue).toBe(start.strengthValue);

    await user.page.getByTestId('h5-extend-time').click();
    await user.page.waitForTimeout(80);
    const extended = await countdownReport();
    expect(extended.remaining).toBe(35);
    expect(extended.progress).toBeGreaterThan(57);
    expect(extended.progress).toBeLessThan(59);
    expect(extended.statusLow).toBe(false);
    expect(extended.strengthValue).toBe(start.strengthValue);

    await user.page.evaluate(() => window.__h5FeedbackHarness.view.tick(1));
    const afterExtendTick = await countdownReport();
    expect(afterExtendTick.progress).toBeLessThan(extended.progress);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.listeners.onAwaitAction?.(1, battle.getOptions(battle.players[1]), 0);
    });
    const expiredSync = await countdownReport();
    expect(expiredSync.remaining).toBe(0);
    expect(expiredSync.progress).toBe(0);
    expect(expiredSync.label).toContain('轮到行动 · 0s');

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.listeners.onAllInReveal?.(battle.activePlayers());
    });
    const revealed = await countdownReport();
    expect(revealed.strengthValue).toBe('--');
    expect(revealed.strengthGrade).toBe('亮牌中');
    expect(revealed.strengthAria).toBeNull();

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.round += 1;
      battle.listeners.onRoundStart?.(battle.round, { sb: 10, bb: 20 }, 1);
    });
    const nextRound = await countdownReport();
    expect(nextRound.strengthValue).toMatch(/^\d{1,3}%$/u);
    expect(nextRound.strengthGrade).toMatch(/^(劣势|胶着|优势|碾压)$/u);
    expect(nextRound.strengthAria).toBeGreaterThanOrEqual(0);
    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await user.page.evaluate(() => {
      window.__h5FeedbackHarness?.observer?.disconnect();
      window.__h5FeedbackHarness?.view?.destroy?.();
      delete window.__h5FeedbackHarness;
    }).catch(() => {});
    await closeContext(user.context);
  }
});

test('H5 主动技能：仅本人行动窗口可见可用且规则层同步拒绝越权', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);
    const skill = user.page.getByTestId('h5-use-skill');

    const blocked = await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      const me = battle.players[1];
      battle.street = 'preflop';
      me.energy = 5;
      me.skillUsed = false;
      me.folded = false;
      me.alive = true;
      battle.actingIdx = 2;
      battle.waitingIdx = 2;
      battle.listeners.onTurnStart?.(2);
      const before = me.energy;
      return { accepted: battle.useSkill(1), before, after: me.energy, used: me.skillUsed };
    });
    expect(blocked).toEqual({ accepted: false, before: 5, after: 5, used: false });
    await expect(skill).toBeDisabled();
    await expect(user.page.locator('.h5-me__skill-state')).toContainText('仅可在轮到你行动时发动');

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      const me = battle.players[1];
      battle.actingIdx = 1;
      battle.waitingIdx = 1;
      battle.listeners.onTurnStart?.(1);
      battle.listeners.onAwaitAction?.(1, battle.getOptions(me), 30);
    });
    await expect(skill).toBeEnabled();
    await skill.click();
    await expect.poll(() => user.page.evaluate(() => ({
      energy: window.__h5FeedbackHarness.battle.players[1].energy,
      used: window.__h5FeedbackHarness.battle.players[1].skillUsed,
    }))).toEqual({ energy: 3, used: true });

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.actingIdx = 0;
      battle.waitingIdx = null;
      battle.listeners.onAction?.(1, 'check', 0);
    });
    await expect(skill).toBeDisabled();
    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await user.page.evaluate(() => {
      window.__h5FeedbackHarness?.observer?.disconnect();
      window.__h5FeedbackHarness?.view?.destroy?.();
      delete window.__h5FeedbackHarness;
    }).catch(() => {});
    await closeContext(user.context);
  }
});

test('H5 对局反馈：中牌特效、筹码净额与整局结果分类清晰可见', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);

    const classified = await user.page.evaluate(async () => {
      const { classifyH5GameOutcome } = await import('/js/ui/h5/app.js');
      const ranking = [
        { idx: '2', hp: 900, alive: true },
        { idx: 1, hp: 600, alive: true },
        { idx: 3, hp: 0, alive: false },
      ];
      return {
        victory: classifyH5GameOutcome(ranking, 2),
        defeat: classifyH5GameOutcome(ranking, '1'),
        complete: classifyH5GameOutcome(ranking, 99),
      };
    });
    expect(classified.victory).toMatchObject({
      myRank: 1,
      totalPlayers: 3,
      outcome: 'victory',
      outcomeLabel: '胜利',
      podium: true,
    });
    expect(classified.defeat).toMatchObject({
      myRank: 2,
      outcome: 'defeat',
      outcomeLabel: '失败',
      podium: true,
    });
    expect(classified.complete).toMatchObject({
      myRank: 0,
      outcome: 'complete',
      outcomeLabel: '对局结束',
      podium: false,
    });

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.listeners.onDeal?.();
      battle.revealed = 3;
      battle.listeners.onStreet?.('flop', 3);
    });
    await expect.poll(async () => {
      const events = await h5FeedbackEvents(user.page, 'h5-hand-hit');
      return events.some((event) => /中牌|双雄并立|一对/u.test(event.text));
    }, { message: '公共牌让本人由高牌升级为一对时，应出现中牌提示' }).toBe(true);
    await expect.poll(async () => (
      (await h5FeedbackEvents(user.page, 'h5-hand-hit-effect'))
        .some((event) => /is-(?:made|strong|legendary)/u.test(event.className))
    ), { message: '中牌时应挂载带牌型强度动画类的独立视觉特效层' }).toBe(true);
    await expect.poll(async () => (
      (await h5FeedbackEvents(user.page, 'h5-combo-card'))
        .some((event) => /h5-card--hand/u.test(event.className))
    ), { message: '中牌时应高亮组成当前牌型的本人底牌' }).toBe(true);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      const me = battle.players[1];
      me.showdownInfo = { name: '双雄并立', cat: 2, score: 1 };
      battle.listeners.onShowdown?.({
        entrants: [me, battle.players[2]],
        wonAmount: { 1: 240 },
        netResult: { 1: 160, 2: -160 },
        totalPot: 240,
        pots: [],
      });
    });
    await expect(user.page.getByTestId('h5-round-result')).toHaveCount(0);
    const myWin = user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="1"]');
    await expect(myWin).toHaveAttribute('data-net', '160');
    await expect(myWin).toHaveText('+160');
    await expect(user.page.locator('[data-testid="h5-chip-flight"][data-winner-idx="1"]'))
      .toHaveCount(1);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      battle.players[1].betRound = 80;
      battle.listeners.onPotAwarded?.([2], 100, true, 0, { 2: 20 });
    });
    await expect(user.page.getByTestId('h5-round-result')).toHaveCount(0);
    const myLoss = user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="1"]');
    const opponentWin = user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="2"]');
    await expect(myLoss).toHaveAttribute('data-net', '-80');
    await expect(myLoss).toHaveText('-80');
    await expect(opponentWin).toHaveAttribute('data-net', '20');
    await expect(opponentWin).toHaveText('+20');
    await expect(user.page.locator('[data-testid="h5-chip-flight"][data-winner-idx="2"]'))
      .toHaveCount(1);

    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await user.page.evaluate(() => {
      window.__h5FeedbackHarness?.observer?.disconnect();
      window.__h5FeedbackHarness?.view?.destroy?.();
      delete window.__h5FeedbackHarness;
    }).catch(() => {});
    await closeContext(user.context);
  }
});

test('H5 摊牌结算：展示全部亮牌者手牌、牌型、获池与净输赢', async ({ browser }) => {
  const user = await newUser(browser, { width: 844, height: 390 });
  try {
    await enterH5(user.page);
    await mountH5FeedbackHarness(user.page);

    await user.page.evaluate(() => {
      const { battle } = window.__h5FeedbackHarness;
      const me = battle.players[1];
      const winner = battle.players[2];
      const otherLoser = battle.players[3];

      me.playerName = '本人测试';
      me.hole = [
        { rank: 14, suit: 1 },
        { rank: 13, suit: 2 },
      ];
      me.betRound = 120;
      me.showdownInfo = { name: '双雄并立', cat: 2, score: 200 };

      winner.playerName = '对手赢家';
      winner.hole = [
        { rank: 7, suit: 3 },
        { rank: 7, suit: 2 },
      ];
      winner.betRound = 120;
      winner.showdownInfo = { name: '三英聚首', cat: 4, score: 400 };

      otherLoser.playerName = '另一亮牌者';
      otherLoser.hole = [
        { rank: 9, suit: 1 },
        { rank: 13, suit: 4 },
      ];
      otherLoser.betRound = 100;
      otherLoser.showdownInfo = { name: '双雄并立', cat: 2, score: 180 };

      battle.listeners.onShowdown?.({
        entrants: [me, winner, otherLoser],
        wonAmount: { 2: 340 },
        netResult: { 1: -120, 2: 220, 3: -100 },
        totalPot: 340,
        pots: [
          {
            label: '主池',
            amount: 300,
            eligibleIds: [1, 2, 3],
            winnerIds: [2],
            awards: { 2: 300 },
            netWinnings: { 2: 200 },
          },
          {
            label: '边池 1',
            amount: 40,
            eligibleIds: [1, 2],
            winnerIds: [2],
            awards: { 2: 40 },
            netWinnings: { 2: 20 },
          },
        ],
      });
    });

    await expect(user.page.getByTestId('h5-showdown-summary')).toHaveCount(0);
    await expect(user.page.getByTestId('h5-round-result')).toHaveCount(0);

    const reveals = user.page.getByTestId('h5-settlement-reveal');
    await expect(reveals).toHaveCount(3);
    const rowFor = (idx) => user.page.locator(
      `[data-testid="h5-settlement-reveal"][data-player-idx="${idx}"]`,
    );

    const me = rowFor(1);
    await expect(me).toHaveAttribute('aria-label', /本人测试.*双雄并立/u);
    await expect(me.getByTestId('h5-settlement-card')).toHaveCount(2);
    await expect(me.getByTestId('h5-settlement-card').nth(0)).toHaveAttribute('aria-label', '♠A');
    await expect(me.getByTestId('h5-settlement-card').nth(1)).toHaveAttribute('aria-label', '♥K');
    await expect(me.getByTestId('h5-settlement-hand-type')).toContainText('双雄并立');
    await expect(user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="1"]'))
      .toHaveAttribute('data-net', '-120');

    const winner = rowFor(2);
    await expect(winner).toHaveAttribute('aria-label', /对手赢家.*三英聚首/u);
    await expect(winner.getByTestId('h5-settlement-card')).toHaveCount(2);
    await expect(winner.getByTestId('h5-settlement-card').nth(0)).toHaveAttribute('aria-label', '♦7');
    await expect(winner.getByTestId('h5-settlement-card').nth(1)).toHaveAttribute('aria-label', '♥7');
    await expect(winner.getByTestId('h5-settlement-hand-type')).toContainText('三英聚首');
    await expect(user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="2"]'))
      .toHaveAttribute('data-net', '220');
    await expect(user.page.locator('[data-testid="h5-chip-flight"][data-winner-idx="2"]'))
      .toHaveCount(2);

    const otherLoser = rowFor(3);
    await expect(otherLoser).toHaveAttribute('aria-label', /另一亮牌者.*双雄并立/u);
    await expect(otherLoser.getByTestId('h5-settlement-card')).toHaveCount(2);
    await expect(otherLoser.getByTestId('h5-settlement-card').nth(0)).toHaveAttribute('aria-label', '♠9');
    await expect(otherLoser.getByTestId('h5-settlement-card').nth(1)).toHaveAttribute('aria-label', '♣K');
    await expect(otherLoser.getByTestId('h5-settlement-hand-type')).toContainText('双雄并立');
    await expect(user.page.locator('[data-testid="h5-chip-delta"][data-player-idx="3"]'))
      .toHaveAttribute('data-net', '-100');

    expect(unexpectedBrowserErrors([user])).toEqual([]);
  } finally {
    await user.page.evaluate(() => {
      window.__h5FeedbackHarness?.observer?.disconnect();
      window.__h5FeedbackHarness?.view?.destroy?.();
      delete window.__h5FeedbackHarness;
    }).catch(() => {});
    await closeContext(user.context);
  }
});

test('PC 房主 + H5 成员完成大厅到结算再回房的混合端全流程', async ({ browser }) => {
  const pc = await newUser(browser, { width: 1440, height: 900 });
  const h5 = await newUser(browser, { width: 844, height: 390 });

  try {
  await pc.page.goto('/index.html');
  await pc.page.getByTestId('pc-mode-online').click();
  await expect(pc.page.getByTestId('pc-screen-lobby')).toBeVisible();
  await expect(pc.page.getByTestId('pc-player-sync')).toContainText('已同步');
  await expect(pc.page.getByTestId('pc-player-id')).toContainText(/#[A-F0-9]{8}/u);
  await expect(pc.page.getByTestId('pc-stat-matches')).toHaveText('0');
  await pc.page.getByTestId('pc-player-stats-open').click();
  const pcLobbyStatsPanel = pc.page.getByTestId('pc-player-stats-panel');
  await expectPokerStatsPanel(pcLobbyStatsPanel, 'pc-player-stats');
  await expect(pcLobbyStatsPanel.getByTestId('pc-player-stats-hands').locator('strong')).toHaveText('0');
  await closePokerStatsPanel(pc.page, pcLobbyStatsPanel);
  await pc.page.getByTestId('pc-room-id').fill('999999');
  await pc.page.getByTestId('pc-join-by-id').click();
  await expect(pc.page.getByTestId('pc-notice')).toContainText('队伍不存在');
  await pc.page.getByTestId('pc-profile-edit').click();
  await pc.page.getByTestId('pc-profile-name').fill('PC房主');
  await pc.page.getByRole('button', { name: '选择墨纹章' }).click();
  await pc.page.getByTestId('pc-profile-save').click();
  await expect(pc.page.getByTestId('pc-profile-save')).toHaveCount(0);
  await expect(pc.page.getByTestId('pc-topbar-profile')).toContainText('PC房主');
  await pc.page.getByTestId('pc-create-team').click();
  await pc.page.getByTestId('pc-dialog-confirm').click();
  await expect(pc.page.getByTestId('pc-screen-room')).toBeVisible();

  await enterH5(h5.page);
  await h5.page.getByTestId('h5-mode-online').click();
  await expect(h5.page.getByTestId('h5-online-lobby')).toBeVisible();
  await expect(h5.page.getByTestId('h5-player-sync')).toContainText('已同步');
  await expect(h5.page.getByTestId('h5-player-id')).toContainText(/#[A-F0-9]{8}/u);
  await h5.page.getByTestId('h5-player-stats-open').click();
  const h5LobbyStatsPanel = h5.page.getByTestId('h5-player-stats-panel');
  await expectPokerStatsPanel(h5LobbyStatsPanel, 'h5-player-stats');
  await closePokerStatsPanel(h5.page, h5LobbyStatsPanel);
  await h5.page.getByTestId('h5-profile-edit').click();
  await h5.page.getByTestId('h5-profile-name').fill('H5成员');
  await h5.page.getByRole('dialog', { name: '编辑玩家档案' })
    .getByRole('button', { name: '月', exact: true }).click();
  await h5.page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(h5.page.getByTestId('h5-player-id')).toContainText('H5成员');
  await h5.page.getByRole('button', { name: '加入', exact: true }).click();
  await expect(h5.page.getByTestId('h5-online-room')).toBeVisible();
  await expect(pc.page.getByTestId('pc-room-members')).toContainText('H5成员');

  const pcMembers = await roomMemberSnapshot(pc.page, 'pc');
  const h5Members = await roomMemberSnapshot(h5.page, 'h5');
  expect(pcMembers).toHaveLength(2);
  expect(h5Members).toHaveLength(2);
  for (const name of ['PC房主', 'H5成员']) {
    const pcMember = pcMembers.find((member) => member.name === name);
    const h5Member = h5Members.find((member) => member.name === name);
    expect(pcMember, `${name} 应出现在 PC 房间`).toBeTruthy();
    expect(h5Member, `${name} 应出现在 H5 房间`).toBeTruthy();
    expect(pcMember.id).toBeTruthy();
    expect(pcMember.id).toBe(h5Member.id);
    expect(pcMember.emblem).toBe(h5Member.emblem);
  }
  expect(new Set(pcMembers.map((member) => member.id)).size).toBe(2);
  expect(pcMembers.find((member) => member.name === 'PC房主')).toMatchObject({
    emblem: '墨', isYou: true, isOwner: true,
  });
  expect(h5Members.find((member) => member.name === 'H5成员')).toMatchObject({
    emblem: '月', isYou: true, isOwner: false,
  });

  const pcRoomOpponent = pc.page.locator('[data-testid="pc-room-member"][data-is-you="false"]');
  await pcRoomOpponent.getByTestId('pc-room-member-stats-open').click();
  const pcRoomStatsPanel = pc.page.getByTestId('pc-player-stats-panel');
  await expectPokerStatsPanel(pcRoomStatsPanel, 'pc-player-stats');
  await closePokerStatsPanel(pc.page, pcRoomStatsPanel);

  const h5RoomOpponent = h5.page.locator('[data-testid="h5-room-member"][data-is-you="false"]');
  await h5RoomOpponent.click();
  const h5RoomStatsPanel = h5.page.getByTestId('h5-player-stats-panel');
  await expectPokerStatsPanel(h5RoomStatsPanel, 'h5-player-stats');
  await closePokerStatsPanel(h5.page, h5RoomStatsPanel);

  await h5.context.setOffline(true);
  await expect(h5.page.getByTestId('h5-reconnect-overlay')).toBeVisible({ timeout: 5_000 });
  await expect(pc.page.getByTestId('pc-room-members')).toContainText('重连中');
  await expect(pc.page.getByTestId('pc-start-pick')).toBeDisabled();
  await h5.context.setOffline(false);
  await expect(h5.page.getByTestId('h5-reconnect-overlay')).toBeHidden({ timeout: 12_000 });
  await expect(h5.page.getByTestId('h5-online-room')).toBeVisible();
  await expect(pc.page.getByTestId('pc-room-members')).toContainText('在线');
  await expect(pc.page.getByTestId('pc-start-pick')).toBeEnabled();

  await pc.page.getByTestId('pc-start-pick').click();
  await expect(pc.page.getByTestId('pc-screen-pick')).toBeVisible();
  await expect(h5.page.getByTestId('h5-online-pick')).toBeVisible();
  await pc.page.getByTestId('pc-confirm-hero').click();
  await h5.page.getByTestId('h5-hero-diaochan').click();
  await h5.page.getByTestId('h5-confirm-hero').click();
  await expect(pc.page.getByTestId('pc-start-game')).toBeEnabled();
  await pc.page.getByTestId('pc-start-game').click();
  await expect(pc.page.getByTestId('pc-battle')).toBeVisible();
  await expect(h5.page.getByTestId('h5-battle')).toBeVisible();

  const pcOwnSeatAvatar = pc.page.locator('.bb-me').getByTestId(/^pc-seat-stats-\d+$/u);
  const pcOwnSeatTestId = await pcOwnSeatAvatar.getAttribute('data-testid');
  const pcSeatIdx = Number(pcOwnSeatTestId?.match(/\d+$/u)?.[0]);
  expect(pcSeatIdx).toBeGreaterThan(0);
  await pcOwnSeatAvatar.hover();
  const pcSeatMiniHud = pc.page.getByTestId(`pc-seat-stats-mini-${pcSeatIdx}`);
  await expect(pcSeatMiniHud).toBeVisible();
  await expect(pcSeatMiniHud).toContainText(/近\s*30\s*天\s*·\s*最近\s*200\s*手/u);
  for (const metric of ['vpip', 'pfr', 'threebet', 'af', 'hands']) {
    await expect(pc.page.getByTestId(`pc-seat-stats-mini-${metric}-${pcSeatIdx}`)).toBeVisible();
  }
  await pcOwnSeatAvatar.click();
  const pcBattleStatsPanel = pc.page.getByTestId('pc-seat-stats-panel');
  await expectPokerStatsPanel(pcBattleStatsPanel, 'pc-seat-stats');
  await closePokerStatsPanel(pc.page, pcBattleStatsPanel);

  const h5OpponentSeat = h5.page.getByTestId(`h5-seat-stats-${pcSeatIdx}`);
  await h5OpponentSeat.click();
  const h5BattleStatsPanel = h5.page.getByTestId('h5-player-stats-panel');
  await expectPokerStatsPanel(h5BattleStatsPanel, `h5-seat-stats-${pcSeatIdx}`);
  await closePokerStatsPanel(h5.page, h5BattleStatsPanel);

  await h5.context.setOffline(true);
  await expect(h5.page.getByTestId('h5-reconnect-overlay')).toBeVisible({ timeout: 5_000 });
  await h5.context.setOffline(false);
  await expect(h5.page.getByTestId('h5-reconnect-overlay')).toBeHidden({ timeout: 12_000 });
  await expect(h5.page.getByTestId('h5-battle')).toBeVisible();
  await expect(h5.page.locator('.h5-card--hand.is-face-up')).toHaveCount(2);
  await expect(h5.page.locator('.h5-card--hand.is-face-up .h5-card__back:visible')).toHaveCount(0);

  await h5.page.setViewportSize({ width: 390, height: 844 });
  await expect(h5.page.getByRole('dialog', { name: '请将手机横置' })).toContainText('联机行动计时仍在继续');
  await expect(h5.page.getByTestId('h5-battle')).not.toBeVisible();
  await h5.page.setViewportSize({ width: 844, height: 390 });
  await expect(h5.page.getByTestId('h5-battle')).toBeVisible();

  const pcCall = pc.page.getByTestId('pc-action-call');
  const h5Call = h5.page.getByTestId('h5-action-call');
  const deadline = Date.now() + 45_000;
  let realUserActions = 0;
  while (Date.now() < deadline) {
    if (await pc.page.getByTestId('pc-back-to-room').count()) break;
    if (await h5.page.getByTestId('h5-back-to-room').count()) break;
    if (await pcCall.count() && await clickWhenReady(pcCall)) realUserActions += 1;
    if (await h5Call.count() && await clickWhenReady(h5Call)) realUserActions += 1;
    await h5.page.waitForTimeout(20);
  }

  expect(realUserActions).toBeGreaterThan(0);
  await Promise.all([
    expect(pc.page.getByTestId('pc-back-to-room')).toBeVisible({ timeout: 12_000 }),
    expect(h5.page.getByTestId('h5-back-to-room')).toBeVisible({ timeout: 12_000 }),
  ]);
  const h5GameOutcome = h5.page.getByTestId('h5-game-result-outcome');
  const h5OutcomeValue = await h5GameOutcome.getAttribute('data-outcome');
  await expect(h5GameOutcome).toContainText(/胜利|失败|对局结束/u);
  expect(['victory', 'defeat', 'complete']).toContain(h5OutcomeValue);
  await expect(h5.page.getByTestId('h5-game-result-rank')).toHaveText(/第 [1-6] 名/u);
  const h5OwnResultRow = h5.page.getByTestId('h5-result-you');
  await expect(h5OwnResultRow).toBeVisible();
  const h5Rank = Number(await h5OwnResultRow.getAttribute('data-rank'));
  expect(h5Rank).toBeGreaterThanOrEqual(1);
  expect(h5Rank).toBeLessThanOrEqual(6);
  expect(h5OutcomeValue).toBe(h5Rank === 1 ? 'victory' : 'defeat');
  await expect(h5.page.locator('[data-testid="h5-result-row"], [data-testid="h5-result-you"]')).toHaveCount(6);
  if (h5Rank <= 3) await expect(h5.page.getByTestId('h5-game-result-podium')).toBeVisible();
  else await expect(h5.page.getByTestId('h5-game-result-podium')).toHaveCount(0);
  await Promise.all([
    pc.page.getByTestId('pc-back-to-room').click(),
    h5.page.getByTestId('h5-back-to-room').click(),
  ]);
  await expect(pc.page.getByTestId('pc-screen-room')).toBeVisible();
  await expect(h5.page.getByTestId('h5-online-room')).toBeVisible();
  await expect(pc.page.getByTestId('pc-room-members')).toContainText('H5成员');
  const pcReturnedMe = pc.page.locator('[data-testid="pc-room-member"][data-is-you="true"]');
  await pcReturnedMe.getByTestId('pc-room-member-stats-open').click();
  const pcPersistedStatsPanel = pc.page.getByTestId('pc-player-stats-panel');
  await expectPokerStatsPanel(pcPersistedStatsPanel, 'pc-player-stats');
  await expect.poll(
    () => pokerHandsValue(pcPersistedStatsPanel.getByTestId('pc-player-stats-hands')),
    { message: 'PC 玩家完成一局后应展示已持久化的非零手数' },
  ).toBeGreaterThan(0);
  await closePokerStatsPanel(pc.page, pcPersistedStatsPanel);

  const h5ReturnedMe = h5.page.locator('[data-testid="h5-room-member"][data-is-you="true"]');
  await h5ReturnedMe.click();
  const h5PersistedStatsPanel = h5.page.getByTestId('h5-player-stats-panel');
  await expectPokerStatsPanel(h5PersistedStatsPanel, 'h5-player-stats');
  await expect.poll(
    () => pokerHandsValue(h5PersistedStatsPanel.getByTestId('h5-player-stats-hands')),
    { message: 'H5 玩家完成一局后应展示已持久化的非零手数' },
  ).toBeGreaterThan(0);
  await closePokerStatsPanel(h5.page, h5PersistedStatsPanel);

  await pc.page.getByTestId('pc-topbar-profile').click();
  await expect(pc.page.getByTestId('pc-profile-stat-matches')).toHaveText('1');
  await expect(pc.page.getByTestId('pc-profile-recent-matches')).toContainText(/第 [1-6] 名/u);

  expect(await pc.page.locator('body').getAttribute('data-platform')).not.toBe('h5');
  expect(await h5.page.locator('body').getAttribute('data-platform')).toBe('h5');
  expect(unexpectedBrowserErrors([pc, h5], { allowOfflineNetworkErrors: true })).toEqual([]);
  } finally {
    await Promise.all([
      closeContext(pc.context),
      closeContext(h5.context),
    ]);
  }
});
