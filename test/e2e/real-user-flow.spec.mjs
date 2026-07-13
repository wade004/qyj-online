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
  databaseDirectory = await mkdtemp(join(tmpdir(), 'qyj-h5-online-e2e-'));
  gameServer = startServer(0, {
    speed: 40,
    heartbeatMs: 0,
    databasePath: join(databaseDirectory, 'players.sqlite'),
    trustedOrigins: [webUrl],
    authRateLimitMultiplier: 10,
  });
  await gameServer.ready;
  wsUrl = `ws://127.0.0.1:${gameServer.wss.address().port}`;
});

test.afterAll(async () => {
  await Promise.all([staticServer?.close(), gameServer?.close()]);
  if (databaseDirectory) {
    await rm(databaseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const PASSWORD = 'H5-Online-Password-2026';
const RUN_ID = Date.now().toString(36).slice(-6);
let sequence = 0;

function account(label) {
  const username = `${label}_${RUN_ID}_${++sequence}`.slice(0, 20);
  return { username, email: `${username}@example.com`, password: PASSWORD };
}

async function createUser(browser, viewport = { width: 844, height: 390 }) {
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

async function enterApp(page) {
  await page.goto('/');
  await page.getByTestId('h5-enter-landscape').click();
  await expect(page.getByTestId('h5-auth')).toBeVisible({ timeout: 10_000 });
}

async function register(page, value) {
  await page.getByTestId('h5-auth-to-register').click();
  await page.getByTestId('h5-register-username').fill(value.username);
  await page.getByTestId('h5-register-email').fill(value.email);
  await page.getByTestId('h5-register-password').fill(value.password);
  await page.getByTestId('h5-register-password-confirm').fill(value.password);
  await page.getByTestId('h5-register-submit').click();
  await expect(page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
}

async function createRoom(page, tableSize) {
  await page.getByTestId('h5-create-team').click();
  await expect(page.getByTestId('h5-table-size-6')).toHaveAttribute('aria-pressed', 'true');
  if (tableSize === 9) {
    await page.getByTestId('h5-table-size-9').click();
    await expect(page.getByTestId('h5-table-size-6')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('h5-table-size-9')).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByTestId('h5-dialog-confirm').click();
  await expect(page.getByTestId('h5-online-room')).toBeVisible();
  await expect(page.getByTestId('h5-room-members')).toHaveAttribute('data-table-size', String(tableSize));
  await expect(page.locator('.h5-room-seat')).toHaveCount(tableSize);
}

async function startOneHumanGame(page, heroId = 'zhugeliang') {
  await page.getByTestId('h5-start-pick').click();
  await expect(page.getByTestId('h5-online-pick')).toBeVisible();
  await page.getByTestId(`h5-hero-${heroId}`).click();
  await page.getByTestId('h5-confirm-hero').click();
  await expect(page.getByTestId('h5-start-game')).toBeEnabled();
  await page.getByTestId('h5-start-game').click();
  await expect(page.getByTestId('h5-battle')).toBeVisible({ timeout: 12_000 });
}

async function battleLayoutSnapshot(page) {
  return page.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
      };
    };
    const intersects = (a, b) => (
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    );
    const table = box(document.querySelector('.h5-table'));
    const dock = box(document.querySelector('.h5-battle__dock'));
    const seats = [...document.querySelectorAll('.h5-seat')].map(box);
    const overlaps = [];
    seats.forEach((seat, index) => seats.slice(index + 1).forEach((other, offset) => {
      if (intersects(seat, other) > 1) overlaps.push([index, index + offset + 1]);
    }));
    return {
      table,
      dock,
      seats,
      overlaps,
      outsideTable: seats.map((seat, index) => ({ seat, index })).filter(({ seat }) => (
        seat.left < table.left - 1 || seat.right > table.right + 1
        || seat.top < table.top - 1 || seat.bottom > table.bottom + 1
      )).map(({ index }) => index),
      touchingDock: seats.map((seat, index) => ({ seat, index })).filter(({ seat }) => (
        seat.bottom > dock.top + 1
      )).map(({ index }) => index),
    };
  });
}

function collectFrames(page) {
  const frames = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      try {
        frames.push(JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload));
      } catch { /* heartbeat or diagnostic frame */ }
    });
  });
  return frames;
}

test('唯一入口：根地址只加载 H5 联网版，竖屏受阻且 PC/旧 H5 入口不存在', async ({ browser }) => {
  const user = await createUser(browser, { width: 390, height: 844 });
  try {
    await user.page.goto('/');
    await expect(user.page.locator('body')).toHaveAttribute('data-platform', 'h5');
    await expect(user.page.locator('body')).toHaveAttribute('data-mode', 'online');
    await expect(user.page.getByTestId('h5-enter-landscape')).toBeVisible();
    await expect(user.page.locator('#h5-stage')).toHaveAttribute('aria-hidden', 'true');
    await expect(user.page.locator('link[href*="css/pc/"]')).toHaveCount(0);
    await expect(user.page.locator('script[src*="entry/pc"]')).toHaveCount(0);

    await user.page.setViewportSize({ width: 844, height: 390 });
    await user.page.getByTestId('h5-enter-landscape').click();
    await expect(user.page.getByTestId('h5-auth')).toBeVisible({ timeout: 10_000 });
    await expect(user.page.getByTestId('h5-mode-single')).toHaveCount(0);
    await expect(user.page.getByTestId('h5-mode-online')).toHaveCount(0);

    expect((await user.page.request.get('/h5.html')).status()).toBe(404);
    expect((await user.page.request.get('/js/entry/pc.js')).status()).toBe(404);
    expect((await user.page.request.get('/css/pc/app.css')).status()).toBe(404);
    expect(user.errors).toEqual([]);
  } finally {
    await user.context.close();
  }
});

test('H5 账号闭环：注册、退出并使用邮箱重新登录', async ({ browser }) => {
  const user = await createUser(browser);
  const value = account('account');
  try {
    await enterApp(user.page);
    await register(user.page, value);
    await expect(user.page.getByTestId('h5-player-id')).toContainText(/#[A-F0-9]{8}/);

    await user.page.getByTestId('h5-profile-edit').click();
    await expect(user.page.getByTestId('h5-account-username')).toHaveText(value.username);
    await expect(user.page.getByTestId('h5-account-email')).toHaveText(value.email);
    await user.page.getByTestId('h5-account-logout').click();
    await expect(user.page.getByTestId('h5-auth-login')).toBeVisible({ timeout: 15_000 });

    await user.page.getByTestId('h5-auth-identifier').fill(value.email);
    await user.page.getByTestId('h5-auth-password').fill(value.password);
    await user.page.getByTestId('h5-auth-submit').click();
    await expect(user.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
    expect(user.errors).toEqual([]);
  } finally {
    await user.context.close();
  }
});

test('联网单人玩法：一名真人创建 6 人桌，服务器补 5 名 AI 并进入对局', async ({ browser }) => {
  const user = await createUser(browser);
  const frames = collectFrames(user.page);
  try {
    await enterApp(user.page);
    await register(user.page, account('solo_online_6'));
    await createRoom(user.page, 6);
    await expect(user.page.getByTestId('h5-online-room')).toContainText(/1\/6/);
    await expect(user.page.getByTestId('h5-start-pick')).toContainText(/1.*真人.*5.*AI/);
    await startOneHumanGame(user.page);

    const call = user.page.getByTestId('h5-action-call');
    await expect(call).toBeAttached();

    await expect.poll(() => frames.find((frame) => frame.ev === 'gameStart') || null).not.toBeNull();
    const gameStart = frames.find((frame) => frame.ev === 'gameStart');
    expect(gameStart.a.players).toHaveLength(6);
    expect(gameStart.a.players.filter((player) => player.isHuman)).toHaveLength(1);
    expect(new Set(gameStart.a.players.map((player) => player.heroId)).size).toBe(6);

    await expect(user.page.locator('.h5-seat')).toHaveCount(5);
    await expect(user.page.locator('.h5-card--hand')).toHaveCount(2);
    await expect(user.page.locator('.h5-me > [data-testid="h5-hole-hand"]')).toHaveCount(1);
    await expect(user.page.getByTestId('h5-self-seat-card')).toHaveCount(1);
    await expect(user.page.locator('.h5-battle__dock > [data-testid="h5-hole-hand"]')).toHaveCount(0);
    await expect(user.page.getByTestId('h5-chat-report')).toBeVisible();
    await expect(user.page.getByTestId('h5-chat-panel')).toBeVisible();

    const chatText = `布局验收_${RUN_ID}`;
    await user.page.getByTestId('h5-chat-input').fill(chatText);
    await user.page.getByTestId('h5-chat-send').click();
    await expect(user.page.getByTestId('h5-chat-list')).toContainText(chatText);
    await user.page.getByTestId('h5-report-tab').click();
    await expect(user.page.getByTestId('h5-report-panel')).toBeVisible();
    await expect(user.page.getByTestId('h5-chat-panel')).toBeHidden();
    await user.page.getByTestId('h5-chat-tab').click();
    await expect(user.page.getByTestId('h5-chat-panel')).toBeVisible();

    await expect(user.page.locator('.h5-seat__skill-glyph')).toHaveText([
      '主', '被', '主', '被', '主', '被', '主', '被', '主', '被',
    ]);
    await expect(user.page.getByTestId('h5-skill-icon')).toHaveText('主');
    await expect(user.page.getByTestId('h5-passive-skill').locator('.h5-passive-button__icon')).toHaveText('被');
    await expect(user.page.locator('[data-testid^="h5-seat-passive-skill-"]')).toHaveCount(5);
    await expect(user.page.locator('.h5-stats-icon')).toHaveCount(6);
    await expect(user.page.locator('.h5-me__hero-name')).toHaveText('诸葛亮');
    await expect(user.page.locator('.h5-me__hero-meta')).toHaveCount(0);
    await expect(user.page.getByTestId('h5-skill-state')).toBeHidden();
    await expect(user.page.locator('.h5-action-area > .h5-gto-advice')).toBeAttached();
    await expect.poll(() => user.page.evaluate(() => {
      const active = document.querySelector('.h5-me__skills > .h5-skill-button')?.getBoundingClientRect();
      const passive = document.querySelector('.h5-me__skills > .h5-passive-button')?.getBoundingClientRect();
      return Boolean(active && passive
        && Math.abs(active.left - passive.left) <= 1
        && passive.top >= active.bottom - .5);
    })).toBe(true);

    const visualContract = await user.page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const hp = rect('.h5-me__hp');
      const energy = rect('.h5-me__energy');
      const board = rect('.h5-card--board');
      const advisor = document.querySelector('.h5-gto-advice');
      const self = rect('.h5-me');
      const selfSeatCard = rect('.h5-me__seat-card');
      const portrait = rect('.h5-me__portrait');
      const identity = rect('.h5-me__identity');
      const stats = rect('.h5-me__stats-open');
      const turnStatus = rect('.h5-me__status');
      const extend = rect('.h5-extend');
      const opponentSeat = rect('.h5-seat');
      const opponentName = rect('.h5-seat__name');
      const opponentHp = rect('.h5-seat__hp');
      const opponentEnergy = rect('.h5-seat__energy');
      const opponentActiveSkill = rect('.h5-seat__skill:not(.h5-seat__skill--passive)');
      const opponentPassiveSkill = rect('.h5-seat__skill--passive');
      const selfActiveSkill = rect('.h5-me__skills > .h5-skill-button');
      const selfPassiveSkill = rect('.h5-me__skills > .h5-passive-button');
      const dealer = document.querySelector('.is-dealer');
      const dealerStyle = dealer ? getComputedStyle(dealer, '::after') : null;
      const hand = rect('.h5-me > .h5-hand');
      const actionArea = rect('.h5-action-area');
      const side = rect('.h5-dock-side');
      return {
        hpInsidePortrait: hp.left >= selfSeatCard.left && hp.right <= selfSeatCard.right
          && hp.top >= portrait.top && hp.bottom <= selfSeatCard.bottom,
        energyAttachedToHp: Math.abs(hp.right - energy.left) <= 2
          && Math.abs(hp.top - energy.top) <= 1 && energy.width < hp.width * .15,
        boardWidth: board.width,
        boardHeight: board.height,
        advisorParent: advisor.parentElement.className,
        selfNameCentered: Math.abs(
          (identity.left + identity.width / 2) - (portrait.left + portrait.width / 2),
        ) <= 8,
        statsOnNameRow: stats.left >= selfSeatCard.left && stats.right <= selfSeatCard.right
          && stats.top >= selfSeatCard.top && stats.bottom <= portrait.top + 2,
        statsIconPainted: getComputedStyle(document.querySelector('.h5-me__stats-open')).backgroundImage
          .includes('linear-gradient'),
        delayNarrowerThanTimer: extend.width <= turnStatus.width * .55,
        selfSkillsVertical: Math.abs(selfActiveSkill.left - selfPassiveSkill.left) <= 1
          && selfPassiveSkill.top >= selfActiveSkill.bottom - .5,
        opponentSkillsVertical: Math.abs(opponentActiveSkill.left - opponentPassiveSkill.left) <= 1
          && opponentPassiveSkill.top >= opponentActiveSkill.bottom - .5,
        opponentSkillsCompact: opponentActiveSkill.width <= opponentSeat.width * .28
          && opponentPassiveSkill.width <= opponentSeat.width * .28,
        opponentEnergyCompact: opponentEnergy.width < opponentSeat.width * .25,
        opponentVitalsAligned: Math.abs(opponentHp.top - opponentEnergy.top) <= 1
          && Math.abs(opponentHp.bottom - opponentEnergy.bottom) <= 1,
        opponentNameReservedLeft: opponentName.left - opponentSeat.left >= 15,
        dealerAtNameRow: dealerStyle
          ? parseFloat(dealerStyle.top) <= 2 && parseFloat(dealerStyle.left) <= 5
          : false,
        handInsideSelf: hand.left >= self.left - 8 && hand.right <= self.right + 8
          && hand.top >= self.top - 8 && hand.bottom <= self.bottom + 8,
        handIsRightBay: hand.left >= selfSeatCard.right && hand.width < selfSeatCard.width,
        sideReserved: actionArea.right <= side.left + 1 && side.width >= 160,
        advisorContained: advisor.getBoundingClientRect().right <= actionArea.right + 1
          && advisor.getBoundingClientRect().left >= actionArea.left - 1,
      };
    });
    expect(visualContract.hpInsidePortrait).toBe(true);
    expect(visualContract.energyAttachedToHp).toBe(true);
    expect(visualContract.boardWidth).toBeGreaterThanOrEqual(39);
    expect(visualContract.boardHeight).toBeGreaterThanOrEqual(55);
    expect(visualContract.advisorParent).toContain('h5-action-area');
    expect(visualContract.selfNameCentered).toBe(true);
    expect(visualContract.statsOnNameRow).toBe(true);
    expect(visualContract.statsIconPainted).toBe(true);
    expect(visualContract.delayNarrowerThanTimer).toBe(true);
    expect(visualContract.selfSkillsVertical).toBe(true);
    expect(visualContract.opponentSkillsVertical).toBe(true);
    expect(visualContract.opponentSkillsCompact).toBe(true);
    expect(visualContract.opponentEnergyCompact).toBe(true);
    expect(visualContract.opponentVitalsAligned).toBe(true);
    expect(visualContract.opponentNameReservedLeft).toBe(true);
    expect(visualContract.dealerAtNameRow).toBe(true);
    expect(visualContract.handInsideSelf).toBe(true);
    expect(visualContract.handIsRightBay).toBe(true);
    expect(visualContract.sideReserved).toBe(true);
    expect(visualContract.advisorContained).toBe(true);

    const sixSeatLayout = await battleLayoutSnapshot(user.page);
    expect(sixSeatLayout.outsideTable).toEqual([]);
    expect(sixSeatLayout.touchingDock).toEqual([]);
    expect(sixSeatLayout.overlaps).toEqual([]);
    const sixSeatArc = await user.page.evaluate(() => {
      const table = document.querySelector('.h5-table').getBoundingClientRect();
      return ['.h5-seat--1', '.h5-seat--5'].map((selector) => {
        const seat = document.querySelector(selector).getBoundingClientRect();
        return ((seat.top + seat.height / 2) - table.top) / table.height;
      });
    });
    expect(Math.min(...sixSeatArc)).toBeGreaterThan(.57);
    expect(Math.max(...sixSeatArc)).toBeLessThan(.64);

    const opponentSkill = user.page.locator('.h5-seat__skill').first();
    await opponentSkill.hover();
    await expect(user.page.locator('.h5-seat-skill-preview')).toBeVisible();
    const tooltipContract = await user.page.evaluate(() => {
      const icon = document.querySelector('.h5-seat__skill').getBoundingClientRect();
      const tip = document.querySelector('.h5-seat-skill-preview').getBoundingClientRect();
      const table = document.querySelector('.h5-table').getBoundingClientRect();
      return {
        nearby: Math.hypot((tip.left + tip.width / 2) - (icon.left + icon.width / 2),
          (tip.top + tip.height / 2) - (icon.top + icon.height / 2)) < 260,
        inside: tip.left >= table.left - 1 && tip.right <= table.right + 1
          && tip.top >= table.top - 1 && tip.bottom <= table.bottom + 1,
        zIndex: Number(getComputedStyle(document.querySelector('.h5-seat-skill-preview')).zIndex),
      };
    });
    expect(tooltipContract).toMatchObject({ nearby: true, inside: true, zIndex: 1000 });

    await user.page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(() => user.page.evaluate(() => Number(
      document.getElementById('h5-ui')?.dataset.uiScale || 1,
    ))).toBeGreaterThan(1);
    expect(user.errors).toEqual([]);
  } finally {
    await user.context.close();
  }
});

test('联网单人玩法：一名真人可创建 9 人桌，服务器补 8 名不同英雄 AI', async ({ browser }) => {
  const user = await createUser(browser);
  const frames = collectFrames(user.page);
  try {
    await enterApp(user.page);
    await register(user.page, account('solo_online_9'));
    await createRoom(user.page, 9);
    await expect(user.page.getByTestId('h5-online-room')).toContainText(/1\/9/);
    await expect(user.page.getByTestId('h5-start-pick')).toContainText(/1.*真人.*8.*AI/);
    await startOneHumanGame(user.page, 'diaochan');

    await expect.poll(() => frames.find((frame) => frame.ev === 'gameStart') || null).not.toBeNull();
    const gameStart = frames.find((frame) => frame.ev === 'gameStart');
    expect(gameStart.a.tableSize).toBe(9);
    expect(gameStart.a.players).toHaveLength(9);
    expect(gameStart.a.players.filter((player) => player.isHuman)).toHaveLength(1);
    expect(new Set(gameStart.a.players.map((player) => player.heroId)).size).toBe(9);
    await expect(user.page.locator('.h5-seat')).toHaveCount(8);
    await expect(user.page.getByTestId('h5-battle')).toHaveAttribute('data-player-count', '9');

    const compactLayout = await battleLayoutSnapshot(user.page);
    expect(compactLayout.outsideTable, '844x390').toEqual([]);
    expect(compactLayout.touchingDock, '844x390').toEqual([]);
    expect(compactLayout.overlaps, '844x390').toEqual([]);

    await user.page.setViewportSize({ width: 932, height: 430 });
    await expect(user.page.locator('.h5-seat')).toHaveCount(8);
    const layout = await battleLayoutSnapshot(user.page);
    expect(layout.outsideTable).toEqual([]);
    expect(layout.touchingDock).toEqual([]);
    expect(layout.overlaps).toEqual([]);
    // The compact seat is 74 logical pixels and may render up to about 81.6
    // physical pixels as the landscape scale settles, while retaining clear gaps.
    await expect(user.page.locator('.h5-seat').first()).toHaveCSS('--h5-seat-card-width', '74px');
    expect(Math.min(...layout.seats.map((seat) => seat.width))).toBeGreaterThanOrEqual(74);
    expect(Math.max(...layout.seats.map((seat) => seat.width))).toBeLessThanOrEqual(82);
    expect(Math.max(...layout.seats.map((seat) => seat.height))).toBeLessThanOrEqual(88);

    const additionalViewports = [
      { width: 1024, height: 576 },
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
    ];
    for (const viewport of additionalViewports) {
      const viewportUser = await createUser(browser, viewport);
      try {
        await enterApp(viewportUser.page);
        await register(viewportUser.page, account(`layout_${viewport.width}`));
        await createRoom(viewportUser.page, 9);
        await startOneHumanGame(viewportUser.page, 'diaochan');
        const responsiveLayout = await battleLayoutSnapshot(viewportUser.page);
        expect(responsiveLayout.outsideTable, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(responsiveLayout.touchingDock, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(responsiveLayout.overlaps, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(viewportUser.errors, `${viewport.width}x${viewport.height}`).toEqual([]);
      } finally {
        await viewportUser.context.close();
      }
    }
    expect(user.errors).toEqual([]);
  } finally {
    await user.context.close();
  }
});
