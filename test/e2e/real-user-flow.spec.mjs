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
    const selfSeat = box(document.querySelector('.h5-me__seat-card'));
    const actionButtons = [...document.querySelectorAll('.h5-action-area .h5-actions button')].map(box);
    const overlaps = [];
    seats.forEach((seat, index) => seats.slice(index + 1).forEach((other, offset) => {
      if (intersects(seat, other) > 1) overlaps.push([index, index + offset + 1]);
    }));
    return {
      table,
      dock,
      seats,
      selfSeat,
      actionButtons,
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

async function settlementOverlaySnapshot(page) {
  return page.evaluate(() => {
    const seat = document.querySelector('.h5-seat');
    const portrait = seat.querySelector('.h5-seat__portrait');
    const hp = seat.querySelector('.h5-seat__hp');
    const action = seat.querySelector('.h5-seat__action');
    const heroName = seat.querySelector('.h5-seat__hero-name');
    const seatNo = seat.querySelector('.h5-seat__seat-no');
    const energy = seat.querySelector('.h5-seat__energy');
    const skillIcons = [...seat.querySelectorAll(':scope > .h5-seat__skill')];
    const vitalRow = [seatNo, hp, energy];
    const reveal = document.createElement('span');
    reveal.className = 'h5-seat-hole-reveal h5-settlement-reveal';
    const cards = document.createElement('span');
    cards.className = 'h5-settlement-reveal__cards';
    for (let index = 0; index < 2; index++) {
      const card = document.createElement('span');
      card.className = 'h5-card h5-card--settlement h5-card--seat-reveal';
      cards.append(card);
    }
    const hand = document.createElement('strong');
    hand.className = 'h5-seat-hole-reveal__label h5-settlement-reveal__hand';
    hand.textContent = '双龙戏珠';
    reveal.append(cards, hand);
    portrait.append(reveal);

    const publicReveal = reveal.cloneNode(true);
    publicReveal.className = 'h5-seat-hole-reveal h5-public-hole-reveal';
    publicReveal.querySelector('.h5-settlement-reveal__cards').className = 'h5-public-hole-reveal__cards';
    publicReveal.querySelectorAll('.h5-card').forEach((card) => {
      card.className = 'h5-card h5-card--public-hole h5-card--seat-reveal';
    });
    publicReveal.querySelector('.h5-seat-hole-reveal__label').className = 'h5-seat-hole-reveal__label';
    portrait.append(publicReveal);
    seat.classList.add('is-revealing-hole');

    const annotationsHiddenDuringReveal = getComputedStyle(heroName).visibility === 'hidden'
      && skillIcons.every((icon) => getComputedStyle(icon).visibility === 'hidden');
    const vitalsHiddenDuringReveal = vitalRow.every((node) => (
      getComputedStyle(node).visibility === 'hidden' && Number(getComputedStyle(node).opacity) === 0
    ));
    seat.classList.remove('is-revealing-hole');
    const annotationsRestoredAfterReveal = getComputedStyle(heroName).visibility !== 'hidden'
      && skillIcons.every((icon) => getComputedStyle(icon).visibility !== 'hidden');
    const vitalsRestoredAfterReveal = vitalRow.every((node) => (
      getComputedStyle(node).visibility !== 'hidden' && Number(getComputedStyle(node).opacity) > 0
    ));

    const delta = document.createElement('strong');
    delta.className = 'h5-chip-delta is-loss';
    delta.textContent = '-995';
    action.append(delta);

    const portraitRect = portrait.getBoundingClientRect();
    const revealRect = reveal.getBoundingClientRect();
    const cardRect = cards.firstElementChild.getBoundingClientRect();
    const cardsRect = cards.getBoundingClientRect();
    const handRect = hand.getBoundingClientRect();
    const publicRevealRect = publicReveal.getBoundingClientRect();
    const publicCardRect = publicReveal.querySelector('.h5-card').getBoundingClientRect();
    const hpRect = hp.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    const deltaRect = delta.getBoundingClientRect();
    const result = {
      revealHost: reveal.parentElement.className,
      revealInsidePortrait: revealRect.left >= portraitRect.left - 1
        && revealRect.right <= portraitRect.right + 1
        && revealRect.top >= portraitRect.top - 1
        && revealRect.bottom <= portraitRect.bottom + 1,
      revealAboveVitals: revealRect.bottom <= hpRect.top + 1,
      revealVitalClearance: hpRect.top - revealRect.bottom,
      cardWidth: cardRect.width,
      cardHeight: cardRect.height,
      revealHeight: revealRect.height,
      handBelowCards: handRect.top >= cardsRect.bottom + 1,
      publicRevealMatchesSettlement: Math.abs(publicRevealRect.left - revealRect.left) <= 1
        && Math.abs(publicRevealRect.top - revealRect.top) <= 1
        && Math.abs(publicRevealRect.width - revealRect.width) <= 1
        && Math.abs(publicRevealRect.height - revealRect.height) <= 1,
      publicCardMatchesSettlement: Math.abs(publicCardRect.width - cardRect.width) <= 1
        && Math.abs(publicCardRect.height - cardRect.height) <= 1,
      annotationsHiddenDuringReveal,
      annotationsRestoredAfterReveal,
      vitalsHiddenDuringReveal,
      vitalsRestoredAfterReveal,
      deltaHost: delta.parentElement.className,
      deltaInsideAction: deltaRect.left >= actionRect.left - 1
        && deltaRect.right <= actionRect.right + 1
        && deltaRect.top >= actionRect.top - 1
        && deltaRect.bottom <= actionRect.bottom + 1,
      deltaCentered: Math.abs(
        (deltaRect.left + deltaRect.width / 2) - (actionRect.left + actionRect.width / 2),
      ) <= 1,
    };
    reveal.remove();
    publicReveal.remove();
    delta.remove();
    return result;
  });
}

test('联机房间：6/9 人横屏座位不重叠、默认头像可用且房间聊天可发送', async ({ browser }) => {
  for (const sample of [
    { tableSize: 6, viewport: { width: 844, height: 390 } },
    { tableSize: 9, viewport: { width: 932, height: 430 } },
  ]) {
    const user = await createUser(browser, sample.viewport);
    try {
      await enterApp(user.page);
      await register(user.page, account(`room_${sample.tableSize}`));
      await createRoom(user.page, sample.tableSize);

      const avatar = user.page.locator('.h5-room-seat__avatar').first();
      await expect(avatar).toBeVisible();
      await expect.poll(() => avatar.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

      const message = `${sample.tableSize}人桌房间聊天验收`;
      await user.page.getByTestId('h5-room-chat-input').fill(message);
      await user.page.getByTestId('h5-room-chat-send').click();
      await expect(user.page.getByTestId('h5-room-chat-messages')).toContainText(message);

      const layout = await user.page.evaluate(() => {
        const rect = (node) => {
          const value = node.getBoundingClientRect();
          return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
        };
        const intersects = (a, b) => (
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        );
        const seats = [...document.querySelectorAll('.h5-room-seat')].map(rect);
        const overlaps = [];
        seats.forEach((seat, index) => seats.slice(index + 1).forEach((other, offset) => {
          if (intersects(seat, other) > 1) overlaps.push([index, index + offset + 1]);
        }));
        const chat = rect(document.querySelector('.h5-room-chat'));
        const composer = rect(document.querySelector('.h5-room-chat__composer'));
        return {
          overlaps,
          composerInsideChat: composer.left >= chat.left && composer.right <= chat.right
            && composer.top >= chat.top && composer.bottom <= chat.bottom,
          fitsViewport: document.documentElement.scrollWidth <= window.innerWidth + 1
            && document.documentElement.scrollHeight <= window.innerHeight + 1,
        };
      });
      expect(layout.overlaps).toEqual([]);
      expect(layout.composerInsideChat).toBe(true);
      expect(layout.fitsViewport).toBe(true);

      await user.page.getByTestId('h5-start-pick').click();
      await expect(user.page.getByTestId('h5-online-pick')).toBeVisible();
      await expect(user.page.getByTestId('h5-pick-player')).toHaveCount(1);
      await expect(user.page.getByTestId('h5-pick-player')).toHaveAttribute('data-ready', 'false');

      const pickMessage = `${sample.tableSize}人桌选将聊天验收`;
      await user.page.getByTestId('h5-pick-chat-input').fill(pickMessage);
      await user.page.getByTestId('h5-pick-chat-send').click();
      await expect(user.page.getByTestId('h5-pick-chat-messages')).toContainText(pickMessage);

      const draftLayout = await user.page.evaluate(() => {
        const nodes = [...document.querySelectorAll('.h5-pick-roster, .h5-pick-select, .h5-pick-chat')];
        const boxes = nodes.map((node) => node.getBoundingClientRect());
        const overlap = boxes.some((a, index) => boxes.slice(index + 1).some((b) => (
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 1
        )));
        return {
          columns: boxes.length,
          overlap,
          fitsViewport: document.documentElement.scrollWidth <= window.innerWidth + 1
            && document.documentElement.scrollHeight <= window.innerHeight + 1,
        };
      });
      expect(draftLayout).toEqual({ columns: 3, overlap: false, fitsViewport: true });

      await user.page.getByTestId('h5-hero-zhugeliang').click();
      await user.page.getByTestId('h5-confirm-hero').click();
      await expect(user.page.getByTestId('h5-pick-locked')).toBeVisible();
      await expect(user.page.getByTestId('h5-pick-locked')).toContainText('诸葛亮');
      await expect(user.page.getByTestId('h5-pick-locked')).toContainText('本局不可更换');
      await expect(user.page.getByTestId('h5-pick-select')).toHaveCount(0);
      await expect(user.page.getByTestId('h5-confirm-hero')).toHaveCount(0);
      await expect(user.page.getByTestId('h5-pick-player')).toHaveAttribute('data-ready', 'true');
      await expect(user.page.getByTestId('h5-start-game')).toBeEnabled();
      expect(user.errors).toEqual([]);
    } finally {
      await user.context.close();
    }
  }
});

test('房主可移出离线保留成员并立即继续开局', async ({ browser }) => {
  const owner = await createUser(browser, { width: 932, height: 430 });
  const member = await createUser(browser, { width: 932, height: 430 });
  let memberClosed = false;
  try {
    await enterApp(owner.page);
    await register(owner.page, account('kick_owner'));
    await enterApp(member.page);
    await register(member.page, account('kick_member'));

    await createRoom(owner.page, 6);
    const joinButton = member.page.locator('[data-testid^="h5-join-team-"]').first();
    await expect(joinButton).toBeVisible();
    await joinButton.click();
    await expect(owner.page.getByTestId('h5-room-member')).toHaveCount(2);
    await expect(owner.page.getByTestId('h5-kick-member')).toHaveCount(1);

    await member.context.close();
    memberClosed = true;
    await expect(owner.page.getByTestId('h5-kick-member')).toHaveClass(/is-offline/);
    await expect(owner.page.getByTestId('h5-start-pick')).toBeDisabled();

    await owner.page.getByTestId('h5-kick-member').click();
    await expect(owner.page.getByText('移出后将立即释放席位')).toBeVisible();
    await owner.page.getByTestId('h5-kick-member-confirm').click();
    await expect(owner.page.getByTestId('h5-room-member')).toHaveCount(1);
    await expect(owner.page.getByTestId('h5-start-pick')).toBeEnabled();
    await owner.page.getByTestId('h5-start-pick').click();
    await expect(owner.page.getByTestId('h5-online-pick')).toBeVisible();
    expect(owner.errors).toEqual([]);
  } finally {
    if (!memberClosed) await member.context.close();
    await owner.context.close();
  }
});

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
    await user.page.getByTestId('h5-auth-to-login').click();
    await expect(user.page.getByTestId('h5-auth-identifier')).toHaveCSS('font-size', '16px');
    await user.page.getByTestId('h5-auth-identifier').focus();
    await expect(user.page.locator('#h5-orientation-gate')).toBeHidden();
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

test('手机横屏账号表单：常见尺寸触控高度充足且输入框不越界、不重叠', async ({ browser }) => {
  for (const viewport of [
    { width: 932, height: 430 },
    { width: 844, height: 390 },
    { width: 740, height: 360 },
  ]) {
    const user = await createUser(browser, viewport);
    try {
      await enterApp(user.page);
      await user.page.getByTestId('h5-auth-to-register').click();
      const layout = await user.page.evaluate(() => {
        const rect = (node) => {
          const value = node.getBoundingClientRect();
          return {
            left: value.left, top: value.top, right: value.right, bottom: value.bottom,
            width: value.width, height: value.height,
          };
        };
        const overlap = (a, b) => (
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        );
        const fields = [...document.querySelectorAll('.h5-auth__field')].map(rect);
        const inputs = [...document.querySelectorAll('.h5-auth__input')].map(rect);
        const panel = rect(document.querySelector('.h5-auth__panel'));
        const submit = rect(document.querySelector('.h5-auth__submit'));
        return {
          fields,
          inputs,
          panel,
          submit,
          overlaps: inputs.flatMap((item, index) => inputs.slice(index + 1)
            .map((other) => overlap(item, other))).filter((area) => area > 1),
        };
      });
      expect(layout.inputs).toHaveLength(4);
      expect(layout.overlaps).toEqual([]);
      expect(layout.inputs.every((input) => input.height >= 42)).toBe(true);
      expect(layout.inputs.every((input, index) => (
        input.left >= layout.fields[index].left - 1
        && input.right <= layout.fields[index].right + 1
      ))).toBe(true);
      expect(layout.submit.height).toBeGreaterThanOrEqual(42);
      expect(layout.panel.left).toBeGreaterThanOrEqual(0);
      expect(layout.panel.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(user.errors).toEqual([]);
    } finally {
      await user.context.close();
    }
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
    await user.page.getByTestId('h5-profile-avatar-20').click();
    await expect(user.page.getByTestId('h5-profile-avatar-preview'))
      .toHaveAttribute('src', /avatar-20\.webp$/u);
    await user.page.getByTestId('h5-profile-save').click();
    await expect(user.page.getByTestId('h5-profile-save')).toHaveCount(0);
    await user.page.getByTestId('h5-profile-edit').click();
    await expect(user.page.getByTestId('h5-profile-avatar-20')).toHaveAttribute('aria-pressed', 'true');
    await user.page.getByTestId('h5-account-logout').click();
    await expect(user.page.getByTestId('h5-auth-quick')).toBeVisible({ timeout: 15_000 });
    await user.page.getByTestId('h5-auth-to-login').click();
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

test('H5 联机大厅支持二次确认退出登录', async ({ browser }) => {
  const user = await createUser(browser);
  try {
    await enterApp(user.page);
    await register(user.page, account('lobby_logout'));
    await expect(user.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });

    await user.page.getByTestId('h5-lobby-logout').click();
    await expect(user.page.locator('.h5-dialog')).toContainText('本设备的一键登录凭据也会失效');
    await user.page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(user.page.getByTestId('h5-online-lobby')).toBeVisible();

    await user.page.getByTestId('h5-lobby-logout').click();
    await user.page.getByTestId('h5-lobby-logout-confirm').click();
    await expect(user.page.getByTestId('h5-auth-quick')).toBeVisible({ timeout: 15_000 });
    expect(user.errors).toEqual([]);
  } finally {
    await user.context.close();
  }
});

test('设备一键登录：首次只填昵称、同设备自动进入、补全邮箱密码后可跨设备登录', async ({ browser }) => {
  const first = await createUser(browser);
  const nickname = `一键侠${sequence++}`;
  const email = `quick_${RUN_ID}_${sequence}@example.com`;
  try {
    await enterApp(first.page);
    await expect(first.page.getByTestId('h5-auth-quick')).toBeVisible();
    await first.page.getByTestId('h5-quick-nickname').fill(nickname);
    await first.page.getByTestId('h5-quick-submit').click();
    await expect(first.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
    await expect(first.page.getByTestId('h5-player-id')).toContainText(nickname);

    const firstPlayerId = await first.page.getByTestId('h5-player-id').textContent();
    await first.context.clearCookies({ name: 'qyj_session' });
    await first.page.goto('/');
    await first.page.getByTestId('h5-enter-landscape').click();
    await expect(first.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
    await expect(first.page.getByTestId('h5-player-id')).toHaveText(firstPlayerId || '');

    await first.page.getByTestId('h5-profile-edit').click();
    await first.page.getByTestId('h5-profile-email').fill(email);
    await first.page.getByTestId('h5-profile-new-password').fill(PASSWORD);
    await first.page.getByTestId('h5-profile-confirm-password').fill(PASSWORD);
    await first.page.getByTestId('h5-profile-save').click();
    await expect(first.page.getByTestId('h5-profile-save')).toHaveCount(0);

    const second = await createUser(browser);
    try {
      await enterApp(second.page);
      await second.page.getByTestId('h5-auth-to-login').click();
      await second.page.getByTestId('h5-auth-identifier').fill(email);
      await second.page.getByTestId('h5-auth-password').fill(PASSWORD);
      await second.page.getByTestId('h5-auth-submit').click();
      await expect(second.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
      await expect(second.page.getByTestId('h5-player-id')).toHaveText(firstPlayerId || '');
      expect(second.errors).toEqual([]);
    } finally {
      await second.context.close();
    }
    expect(first.errors).toEqual([]);
  } finally {
    await first.context.close();
  }
});

test('牌局记录：九人座位连续，公牌跟随底牌且只为合法亮牌高亮最终五张', async ({ browser }) => {
  const user = await createUser(browser);
  try {
    await enterApp(user.page);
    const contract = await user.page.evaluate(async () => {
      const { createHandHistoryPanel } = await import('/js/ui/shared/hand-history.js');
      const host = document.createElement('div');
      host.className = 'h5-dialog';
      host.style.cssText = 'position:fixed;inset:8px auto auto 8px;width:760px;max-width:calc(100vw - 16px);z-index:9999';
      document.body.append(host);
      const board = [
        { r: 4, s: 1 }, { r: 5, s: 2 }, { r: 6, s: 3 },
        { r: 13, s: 4 }, { r: 14, s: 1 },
      ];
      const panel = createHandHistoryPanel({
        prefix: 'e2e-history',
        loadPage: async () => ({
          ok: true,
          data: {
            nextCursor: null,
            items: [{
              id: 999,
              roomName: '牌谱布局测试',
              roomId: 9,
              round: 12,
              tableSize: 9,
              dealerSeat: 5,
              resolution: 'showdown',
              playedAt: new Date().toISOString(),
              selfNetResult: 100,
              board,
              players: [
                {
                  seat: 1, isYou: true, playerName: '阳顶天', heroId: 'zhugeliang',
                  hole: [{ r: 7, s: 2 }, { r: 8, s: 4 }], handName: '顺子',
                  participated: true, folded: false, allIn: false, netResult: 100,
                },
                {
                  seat: 3, isYou: false, playerName: '隐藏对手', heroId: 'hanxin',
                  hole: [null, null], handName: null, participated: true,
                  folded: true, allIn: false, netResult: -20,
                },
              ],
            }],
          },
        }),
      });
      host.append(panel.root);
      await panel.load();
      const rows = [...host.querySelectorAll('[data-testid="e2e-history-player"]')];
      const self = rows[0];
      const absent = rows[1];
      const hidden = rows[2];
      const cardsRect = self.querySelector('.hand-history__cards').getBoundingClientRect();
      const stateRect = self.querySelector('.hand-history__state').getBoundingClientRect();
      const selfRect = self.getBoundingClientRect();
      const result = {
        rowCount: rows.length,
        seats: rows.map((row) => row.dataset.playerSeat),
        absentParticipated: absent.dataset.participated,
        absentState: absent.querySelector('.hand-history__state').textContent,
        selfCardCount: self.querySelectorAll('.hand-history__card').length,
        selfHoleCount: self.querySelectorAll('.hand-history__card.is-hole').length,
        selfBoardCount: self.querySelectorAll('.hand-history__card.is-board').length,
        selfBestCount: self.querySelectorAll('.hand-history__card.is-best-five').length,
        topBoardBestCount: host.querySelectorAll('.hand-history__board .is-best-five').length,
        hiddenCardCount: hidden.querySelectorAll('.hand-history__card').length,
        hiddenHoleCount: hidden.querySelectorAll('.hand-history__card.is-hole.is-hidden').length,
        hiddenBestCount: hidden.querySelectorAll('.hand-history__card.is-best-five').length,
        cardsBeforeState: cardsRect.right <= stateRect.left + 1,
        cardsInsideRow: cardsRect.left >= selfRect.left - 1 && cardsRect.right <= selfRect.right + 1,
        uniqueHandNumber: host.querySelector('.hand-history__summary small').textContent,
      };
      host.remove();
      return result;
    });

    expect(contract.rowCount).toBe(9);
    expect(contract.seats).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(contract.absentParticipated).toBe('false');
    expect(contract.absentState).toBe('本局未参与');
    expect(contract.selfCardCount).toBe(7);
    expect(contract.selfHoleCount).toBe(2);
    expect(contract.selfBoardCount).toBe(5);
    expect(contract.selfBestCount).toBe(5);
    expect(contract.topBoardBestCount).toBe(3);
    expect(contract.hiddenCardCount).toBe(7);
    expect(contract.hiddenHoleCount).toBe(2);
    expect(contract.hiddenBestCount).toBe(0);
    expect(contract.cardsBeforeState).toBe(true);
    expect(contract.cardsInsideRow).toBe(true);
    expect(contract.uniqueHandNumber).toContain('唯一局号 #000999');
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

    const chatLayout = await user.page.evaluate(() => {
      const rect = (node) => {
        const value = node.getBoundingClientRect();
        return {
          left: value.left, right: value.right, top: value.top, bottom: value.bottom,
          width: value.width, height: value.height,
        };
      };
      const input = document.querySelector('.h5-chat-input');
      const send = document.querySelector('.h5-chat-send');
      const compose = document.querySelector('.h5-chat-compose');
      return {
        input: rect(input),
        send: rect(send),
        compose: rect(compose),
        inputFontSize: Number.parseFloat(getComputedStyle(input).fontSize),
        placeholderFontSize: Number.parseFloat(getComputedStyle(input, '::placeholder').fontSize),
      };
    });
    expect(chatLayout.input.right).toBeLessThanOrEqual(chatLayout.send.left - 1);
    expect(chatLayout.send.right).toBeLessThanOrEqual(chatLayout.compose.right + 1);
    expect(chatLayout.input.left).toBeGreaterThanOrEqual(chatLayout.compose.left - 1);
    expect(chatLayout.send.height).toBeGreaterThanOrEqual(23);
    expect(chatLayout.inputFontSize).toBeGreaterThanOrEqual(16);
    expect(chatLayout.placeholderFontSize).toBeLessThanOrEqual(8);
    await expect(user.page.getByTestId('h5-chat-send')).toBeDisabled();

    const chatText = `布局验收_${RUN_ID}`;
    await user.page.getByTestId('h5-chat-input').fill(chatText);
    await expect(user.page.getByTestId('h5-chat-send')).toBeEnabled();
    await user.page.getByTestId('h5-chat-send').click();
    await expect(user.page.getByTestId('h5-chat-list')).toContainText(chatText);
    await expect(user.page.getByTestId('h5-chat-send')).toBeDisabled();
    await user.page.getByTestId('h5-report-tab').click();
    await expect(user.page.getByTestId('h5-report-panel')).toBeVisible();
    await expect(user.page.getByTestId('h5-chat-panel')).toBeHidden();
    await user.page.getByTestId('h5-chat-tab').click();
    await expect(user.page.getByTestId('h5-chat-panel')).toBeVisible();

    const opponentSkillGlyphs = await user.page.locator('.h5-seat__skill-glyph').allTextContents();
    expect(opponentSkillGlyphs).toHaveLength(10);
    expect(opponentSkillGlyphs.every((glyph) => ['主', '被'].includes(glyph))).toBe(true);
    await expect(user.page.getByTestId('h5-skill-icon')).toHaveText('主');
    await expect(user.page.getByTestId('h5-passive-skill').locator('.h5-passive-button__icon')).toHaveText('主');
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
      const opponentActiveSkill = rect('.h5-seat__skill--primary');
      const opponentPassiveSkill = rect('.h5-seat__skill--secondary');
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
        sideReserved: actionArea.right <= side.left + 1 && side.width >= 148,
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

    const showdownRevealContract = await user.page.evaluate(() => {
      const portrait = document.querySelector('.h5-seat__portrait');
      const reveal = document.createElement('span');
      reveal.className = 'h5-settlement-reveal';
      const cards = document.createElement('span');
      cards.className = 'h5-settlement-reveal__cards';
      for (let index = 0; index < 2; index++) {
        const card = document.createElement('span');
        card.className = 'h5-card h5-card--settlement';
        cards.append(card);
      }
      const hand = document.createElement('strong');
      hand.className = 'h5-settlement-reveal__hand';
      hand.textContent = '双龙戏珠';
      reveal.append(cards, hand);
      portrait.append(reveal);
      const portraitRect = portrait.getBoundingClientRect();
      const revealRect = reveal.getBoundingClientRect();
      const cardRect = cards.firstElementChild.getBoundingClientRect();
      const result = {
        host: reveal.parentElement.className,
        insidePortrait: revealRect.left >= portraitRect.left - 1
          && revealRect.right <= portraitRect.right + 1
          && revealRect.top >= portraitRect.top - 1
          && revealRect.bottom <= portraitRect.bottom + 1,
        cardWidth: cardRect.width,
        cardHeight: cardRect.height,
      };
      reveal.remove();
      return result;
    });
    expect(showdownRevealContract.host).toContain('h5-seat__portrait');
    expect(showdownRevealContract.insidePortrait).toBe(true);
    expect(showdownRevealContract.cardWidth).toBeGreaterThanOrEqual(24);
    expect(showdownRevealContract.cardHeight).toBeGreaterThanOrEqual(35);

    const settlementOverlay = await settlementOverlaySnapshot(user.page);
    expect(settlementOverlay.revealHost).toContain('h5-seat__portrait');
    expect(settlementOverlay.revealInsidePortrait).toBe(true);
    expect(settlementOverlay.vitalsHiddenDuringReveal).toBe(true);
    expect(settlementOverlay.vitalsRestoredAfterReveal).toBe(true);
    expect(settlementOverlay.deltaHost).toContain('h5-seat__action');
    expect(settlementOverlay.deltaInsideAction).toBe(true);
    expect(settlementOverlay.deltaCentered).toBe(true);
    expect(settlementOverlay.publicRevealMatchesSettlement).toBe(true);
    expect(settlementOverlay.publicCardMatchesSettlement).toBe(true);
    expect(settlementOverlay.annotationsHiddenDuringReveal).toBe(true);
    expect(settlementOverlay.annotationsRestoredAfterReveal).toBe(true);

    const sixSeatLayout = await battleLayoutSnapshot(user.page);
    expect(sixSeatLayout.outsideTable).toEqual([]);
    expect(sixSeatLayout.touchingDock).toEqual([]);
    expect(sixSeatLayout.overlaps).toEqual([]);
    expect(Math.min(...sixSeatLayout.seats.map((seat) => seat.width))).toBeGreaterThanOrEqual(180);
    expect(Math.min(...sixSeatLayout.seats.map((seat) => seat.height))).toBeGreaterThanOrEqual(112);
    expect(sixSeatLayout.dock.height).toBeGreaterThanOrEqual(126);
    expect(sixSeatLayout.selfSeat.height).toBeGreaterThanOrEqual(117);
    expect(Math.min(...sixSeatLayout.actionButtons.map((button) => button.height))).toBeGreaterThanOrEqual(32);
    const sixSeatArc = await user.page.evaluate(() => {
      const table = document.querySelector('.h5-table').getBoundingClientRect();
      return ['.h5-seat--1', '.h5-seat--5'].map((selector) => {
        const seat = document.querySelector(selector).getBoundingClientRect();
        return ((seat.top + seat.height / 2) - table.top) / table.height;
      });
    });
    expect(Math.min(...sixSeatArc)).toBeGreaterThan(.72);
    expect(Math.max(...sixSeatArc)).toBeLessThan(.78);

    for (const viewport of [
      { width: 874, height: 402 },
      { width: 932, height: 430 },
    ]) {
      await user.page.setViewportSize(viewport);
      const phoneLayout = await battleLayoutSnapshot(user.page);
      expect(phoneLayout.outsideTable, `${viewport.width}x${viewport.height}`).toEqual([]);
      expect(phoneLayout.touchingDock, `${viewport.width}x${viewport.height}`).toEqual([]);
      expect(phoneLayout.overlaps, `${viewport.width}x${viewport.height}`).toEqual([]);
      expect(phoneLayout.dock.height, `${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(126);
      expect(Math.min(...phoneLayout.seats.map((seat) => seat.width)), `${viewport.width}x${viewport.height}`)
        .toBeGreaterThanOrEqual(180);
    }
    await user.page.setViewportSize({ width: 844, height: 390 });

    const opponentSkill = user.page.locator('.h5-seat--3 .h5-seat__skill--primary');
    await opponentSkill.hover();
    await expect(user.page.locator('.h5-seat-skill-preview')).toBeVisible();
    const tooltipContract = await user.page.evaluate(() => {
      const iconNode = document.querySelector('.h5-seat--3 .h5-seat__skill--primary');
      const tipNode = document.querySelector('.h5-seat-skill-preview');
      const icon = iconNode.getBoundingClientRect();
      const tip = tipNode.getBoundingClientRect();
      const table = document.querySelector('.h5-table').getBoundingClientRect();
      const board = document.querySelector('.h5-board').getBoundingClientRect();
      const focused = tipNode.querySelector('.h5-unified-skill-display__item.is-focused');
      const overlapArea = (left, right) => Math.max(
        0,
        Math.min(left.right, right.right) - Math.max(left.left, right.left),
      ) * Math.max(
        0,
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
      );
      const horizontalGap = Math.max(icon.left - tip.right, tip.left - icon.right, 0);
      const verticalGap = Math.max(icon.top - tip.bottom, tip.top - icon.bottom, 0);
      return {
        nearby: Math.hypot(horizontalGap, verticalGap) < 100,
        inside: tip.left >= table.left - 1 && tip.right <= table.right + 1
          && tip.top >= table.top - 1 && tip.bottom <= table.bottom + 1,
        boardClear: overlapArea(tip, board) <= 1,
        iconClear: overlapArea(tip, icon) <= 1,
        focusedId: focused?.dataset.skillId || '',
        focusedKind: focused?.dataset.skillKind || '',
        anchorId: iconNode.dataset.skillId || '',
        anchorKind: iconNode.dataset.skillKind || '',
        placement: tipNode.dataset.placement || '',
        itemCount: document.querySelectorAll(
          '.h5-seat-skill-preview .h5-unified-skill-display__item',
        ).length,
        zIndex: Number(getComputedStyle(document.querySelector('.h5-seat-skill-preview')).zIndex),
      };
    });
    expect(tooltipContract).toMatchObject({
      nearby: true,
      inside: true,
      boardClear: true,
      iconClear: true,
      itemCount: 2,
      zIndex: 1000,
    });
    expect(tooltipContract.focusedId).toBe(tooltipContract.anchorId);
    expect(tooltipContract.focusedKind).toBe(tooltipContract.anchorKind);
    expect(tooltipContract.placement).not.toBe('');
    await opponentSkill.click();
    await expect(user.page.locator('.h5-seat-skill-preview')).toHaveClass(/is-pinned/);

    await user.page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(() => user.page.evaluate(() => Number(
      document.getElementById('h5-ui')?.dataset.uiScale || 1,
    ))).toBeGreaterThan(1);

    await expect(user.page.getByTestId('h5-leave-battle')).toBeVisible();
    await expect(user.page.getByTestId('h5-leave-battle')).toHaveAttribute('data-player-alive', 'true');
    await user.page.getByTestId('h5-leave-battle').click();
    await expect(user.page.locator('.h5-dialog')).toContainText('立即执行默认操作');
    await user.page.getByTestId('h5-dialog-confirm').click();
    await expect(user.page.getByTestId('h5-online-lobby')).toBeVisible({ timeout: 15_000 });
    await expect(user.page.getByTestId('h5-active-games')).toContainText('续接牌局');
    await user.page.locator('[data-testid^="h5-rejoin-game-"]').click();
    await expect(user.page.getByTestId('h5-battle')).toBeVisible({ timeout: 15_000 });
    await expect(user.page.getByTestId('h5-reconnect-overlay')).toHaveCount(0, { timeout: 6_000 });
    await expect(user.page.locator('.h5-action-area')).toBeVisible();
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
    const compactSettlement = await settlementOverlaySnapshot(user.page);
    expect(compactLayout.outsideTable, '844x390').toEqual([]);
    expect(compactLayout.touchingDock, '844x390').toEqual([]);
    expect(compactLayout.overlaps, '844x390').toEqual([]);
    expect(Math.min(...compactLayout.seats.map((seat) => seat.width)), '844x390').toBeGreaterThanOrEqual(124);
    expect(Math.min(...compactLayout.seats.map((seat) => seat.height)), '844x390').toBeGreaterThanOrEqual(96);
    expect(compactLayout.dock.height, '844x390').toBeGreaterThanOrEqual(126);
    expect(Math.min(...compactLayout.actionButtons.map((button) => button.height)), '844x390')
      .toBeGreaterThanOrEqual(32);
    expect(compactSettlement.revealInsidePortrait, '844x390').toBe(true);
    expect(compactSettlement.revealHeight, '844x390').toBeGreaterThanOrEqual(52);
    expect(compactSettlement.handBelowCards, '844x390').toBe(true);
    expect(compactSettlement.vitalsHiddenDuringReveal, '844x390').toBe(true);
    expect(compactSettlement.vitalsRestoredAfterReveal, '844x390').toBe(true);
    expect(compactSettlement.publicRevealMatchesSettlement, '844x390').toBe(true);
    expect(compactSettlement.publicCardMatchesSettlement, '844x390').toBe(true);

    await user.page.setViewportSize({ width: 874, height: 402 });
    await expect(user.page.locator('.h5-seat')).toHaveCount(8);
    const iphoneLayout = await battleLayoutSnapshot(user.page);
    expect(iphoneLayout.outsideTable, '874x402').toEqual([]);
    expect(iphoneLayout.touchingDock, '874x402').toEqual([]);
    expect(iphoneLayout.overlaps, '874x402').toEqual([]);
    expect(iphoneLayout.dock.height, '874x402').toBeGreaterThanOrEqual(126);

    await user.page.setViewportSize({ width: 932, height: 430 });
    await expect(user.page.locator('.h5-seat')).toHaveCount(8);
    const layout = await battleLayoutSnapshot(user.page);
    const phoneSettlement = await settlementOverlaySnapshot(user.page);
    expect(layout.outsideTable).toEqual([]);
    expect(layout.touchingDock).toEqual([]);
    expect(layout.overlaps).toEqual([]);
    expect(phoneSettlement.revealInsidePortrait, '932x430').toBe(true);
    expect(phoneSettlement.revealHeight, '932x430').toBeGreaterThanOrEqual(52);
    expect(phoneSettlement.handBelowCards, '932x430').toBe(true);
    expect(phoneSettlement.vitalsHiddenDuringReveal, '932x430').toBe(true);
    expect(phoneSettlement.vitalsRestoredAfterReveal, '932x430').toBe(true);
    expect(phoneSettlement.publicRevealMatchesSettlement, '932x430').toBe(true);
    expect(phoneSettlement.publicCardMatchesSettlement, '932x430').toBe(true);
    // The 124x96 logical card scales with the landscape stage, filling the
    // perimeter while leaving a small collision-safe gutter between seats.
    await expect(user.page.locator('.h5-seat').first()).toHaveCSS('--h5-seat-card-width', '124px');
    expect(Math.min(...layout.seats.map((seat) => seat.width))).toBeGreaterThanOrEqual(124);
    expect(Math.max(...layout.seats.map((seat) => seat.width))).toBeLessThanOrEqual(138);
    expect(Math.min(...layout.seats.map((seat) => seat.height))).toBeGreaterThanOrEqual(96);
    expect(Math.max(...layout.seats.map((seat) => seat.height))).toBeLessThanOrEqual(107);

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
        const settlementLayout = await settlementOverlaySnapshot(viewportUser.page);
        expect(responsiveLayout.outsideTable, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(responsiveLayout.touchingDock, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(responsiveLayout.overlaps, `${viewport.width}x${viewport.height}`).toEqual([]);
        expect(settlementLayout.vitalsHiddenDuringReveal, `${viewport.width}x${viewport.height}`).toBe(true);
        expect(settlementLayout.vitalsRestoredAfterReveal, `${viewport.width}x${viewport.height}`).toBe(true);
        expect(settlementLayout.deltaInsideAction, `${viewport.width}x${viewport.height}`).toBe(true);
        expect(settlementLayout.deltaCentered, `${viewport.width}x${viewport.height}`).toBe(true);
        expect(settlementLayout.publicRevealMatchesSettlement, `${viewport.width}x${viewport.height}`).toBe(true);
        expect(settlementLayout.publicCardMatchesSettlement, `${viewport.width}x${viewport.height}`).toBe(true);
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
