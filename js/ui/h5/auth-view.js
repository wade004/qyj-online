import { button, clear, element } from '../shared/dom.js';

const AUTH_VIEWS = new Set(['quick', 'login', 'register', 'reset-request', 'reset-confirm']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function textMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') return textMessage(value.message || value.error || value.reason);
  return String(value);
}

function stateData(state = {}) {
  return state.data && typeof state.data === 'object' ? state.data : {};
}

function authViewFor(state = {}) {
  const raw = String(
    state.authView
      || state.view
      || state.data?.authView
      || state.data?.view
      || state.data?.mode
      || state.screen
      || 'login',
  ).toLowerCase();
  if (AUTH_VIEWS.has(raw)) return raw;
  if (raw.includes('register')) return 'register';
  if (raw.includes('reset-confirm') || raw.includes('new-password')) return 'reset-confirm';
  if (raw.includes('reset') || raw.includes('forgot')) return 'reset-request';
  return 'quick';
}

function resultFailure(result, fallback) {
  if (result === false) return fallback;
  if (!result || typeof result !== 'object') return '';
  if (result.ok !== false && result.success !== false && !(result.error && result.ok !== true)) return '';
  return textMessage(result.error || result.message) || fallback;
}

function inputField({
  label,
  testId,
  type = 'text',
  value = '',
  autocomplete,
  inputmode,
  minlength,
  maxlength,
  placeholder = '',
}) {
  const input = element('input', {
    className: 'h5-auth__input',
    attrs: {
      type,
      value,
      required: true,
      autocomplete,
      inputmode,
      minlength,
      maxlength,
      placeholder,
      autocapitalize: type === 'email' || inputmode === 'email' ? 'none' : undefined,
      spellcheck: type === 'email' || inputmode === 'email' ? 'false' : undefined,
      'data-testid': testId,
    },
  });
  return {
    input,
    node: element('label', { className: 'h5-auth__field' }, [
      element('span', { text: label }),
      input,
    ]),
  };
}

function feedbackNodes(state = {}) {
  const data = stateData(state);
  const errorText = textMessage(state.authError || state.error || data.authError || data.error);
  const statusText = textMessage(state.authStatus || state.status || data.authStatus || data.status);
  const error = element('p', {
    className: 'h5-auth__feedback h5-auth__error',
    text: errorText,
    attrs: {
      role: 'alert',
      'aria-live': 'assertive',
      'data-testid': 'h5-auth-error',
      hidden: !errorText,
    },
  });
  const status = element('p', {
    className: 'h5-auth__feedback h5-auth__status',
    text: statusText,
    attrs: {
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'h5-auth-status',
      hidden: !statusText,
    },
  });
  return { error, status };
}

function setFeedback(node, message) {
  const text = textMessage(message);
  node.textContent = text;
  node.hidden = !text;
}

function selectView(session, view) {
  if (typeof session?.selectAuthView === 'function') session.selectAuthView(view);
}

function setFormBusy(form, busy, submit, idleText, busyText) {
  form.setAttribute('aria-busy', busy ? 'true' : 'false');
  for (const control of form.querySelectorAll('input, button')) control.disabled = busy;
  submit.textContent = busy ? busyText : idleText;
}

async function runSessionAction({
  form,
  submit,
  session,
  method,
  payload,
  feedback,
  idleText,
  busyText,
  successText,
  failureText,
}) {
  const action = session?.[method];
  if (typeof action !== 'function') {
    setFeedback(feedback.error, '账号服务暂不可用，请稍后重试');
    return false;
  }
  setFeedback(feedback.error, '');
  setFeedback(feedback.status, '');
  setFormBusy(form, true, submit, idleText, busyText);
  try {
    const result = await action.call(session, payload);
    const failure = resultFailure(result, failureText);
    if (failure) {
      setFeedback(feedback.error, failure);
      return false;
    }
    setFeedback(feedback.status, textMessage(result?.message) || successText);
    return true;
  } catch (error) {
    setFeedback(feedback.error, textMessage(error) || failureText);
    return false;
  } finally {
    setFormBusy(form, false, submit, idleText, busyText);
  }
}

function authLink(label, testId, session, view) {
  return button(label, {
    className: 'h5-auth__link',
    attrs: { 'data-testid': testId },
    on: { click: () => selectView(session, view) },
  });
}

function quickLoginForm({ state, session, feedback }) {
  const data = stateData(state);
  const nickname = inputField({
    label: '玩家昵称',
    testId: 'h5-quick-nickname',
    value: data.nickname || '',
    autocomplete: 'nickname',
    minlength: 1,
    maxlength: 8,
    placeholder: '输入昵称即可开始',
  });
  const submit = button('一键登录并进入联机', {
    className: 'h5-primary-button h5-auth__submit',
    attrs: { type: 'submit', 'data-testid': 'h5-quick-submit' },
  });
  const form = element('form', {
    className: 'h5-auth__form h5-auth__form--quick',
    attrs: { 'data-testid': 'h5-auth-quick', novalidate: true },
  }, [
    element('p', {
      className: 'h5-auth__hint',
      text: '首次只需填写昵称。本浏览器会保存安全设备凭证，下次进入将自动登录。',
    }),
    nickname.node,
    feedback.error,
    feedback.status,
    submit,
    element('p', {
      className: 'h5-auth__device-note',
      text: '清除浏览器数据或更换设备后，需要使用已设置的邮箱和密码登录。',
    }),
    element('div', { className: 'h5-auth__links' }, [
      authLink('账号密码登录', 'h5-auth-to-login', session, 'login'),
      authLink('注册完整账号', 'h5-auth-to-register', session, 'register'),
    ]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = nickname.input.value.trim().normalize('NFC');
    if ([...value].length < 1 || [...value].length > 8
      || /[<>\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u.test(value)) {
      setFeedback(feedback.error, '昵称需为 1–8 个可用字符');
      nickname.input.focus();
      return;
    }
    await runSessionAction({
      form,
      submit,
      session,
      method: 'quickLogin',
      payload: { nickname: value },
      feedback,
      idleText: '一键登录并进入联机',
      busyText: '正在建立设备账号…',
      successText: '登录成功，正在进入大厅…',
      failureText: '设备快捷登录失败，请稍后重试',
    });
  });
  return { form, focus: nickname.input };
}

function loginForm({ state, session, feedback }) {
  const data = stateData(state);
  const identifier = inputField({
    label: '用户名或邮箱',
    testId: 'h5-auth-identifier',
    value: data.identifier || data.login || '',
    autocomplete: 'username',
    maxlength: 254,
    placeholder: '用户名 / 邮箱',
  });
  const password = inputField({
    label: '密码',
    testId: 'h5-auth-password',
    type: 'password',
    autocomplete: 'current-password',
    maxlength: 128,
    placeholder: '登录密码',
  });
  const submit = button('登录并进入联机', {
    className: 'h5-primary-button h5-auth__submit',
    attrs: { type: 'submit', 'data-testid': 'h5-auth-submit' },
  });
  const form = element('form', {
    className: 'h5-auth__form',
    attrs: { 'data-testid': 'h5-auth-login', novalidate: true },
  }, [
    identifier.node,
    password.node,
    feedback.error,
    feedback.status,
    submit,
    element('div', { className: 'h5-auth__links' }, [
      authLink('忘记密码', 'h5-auth-forgot', session, 'reset-request'),
      authLink('注册账号', 'h5-auth-to-register', session, 'register'),
    ]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const login = identifier.input.value.trim();
    if (!login) {
      setFeedback(feedback.error, '请输入用户名或邮箱');
      identifier.input.focus();
      return;
    }
    if (!password.input.value) {
      setFeedback(feedback.error, '请输入密码');
      password.input.focus();
      return;
    }
    await runSessionAction({
      form,
      submit,
      session,
      method: 'loginAccount',
      payload: { identifier: login, password: password.input.value },
      feedback,
      idleText: '登录并进入联机',
      busyText: '正在登录…',
      successText: '登录成功，正在进入大厅…',
      failureText: '登录失败，请检查账号和密码',
    });
  });
  return { form, focus: identifier.input };
}

function registerForm({ state, session, feedback }) {
  const data = stateData(state);
  const username = inputField({
    label: '用户名',
    testId: 'h5-register-username',
    value: data.username || '',
    autocomplete: 'username',
    minlength: 2,
    maxlength: 24,
    placeholder: '2–24 个字符',
  });
  const email = inputField({
    label: '邮箱',
    testId: 'h5-register-email',
    type: 'email',
    value: data.email || '',
    autocomplete: 'email',
    inputmode: 'email',
    maxlength: 254,
    placeholder: '登录 / 找回密码',
  });
  const password = inputField({
    label: '密码',
    testId: 'h5-register-password',
    type: 'password',
    autocomplete: 'new-password',
    minlength: 8,
    maxlength: 128,
    placeholder: '至少 8 个字符',
  });
  const confirmation = inputField({
    label: '确认密码',
    testId: 'h5-register-password-confirm',
    type: 'password',
    autocomplete: 'new-password',
    minlength: 8,
    maxlength: 128,
    placeholder: '再次输入密码',
  });
  const submit = button('注册并进入联机', {
    className: 'h5-primary-button h5-auth__submit',
    attrs: { type: 'submit', 'data-testid': 'h5-register-submit' },
  });
  const form = element('form', {
    className: 'h5-auth__form',
    attrs: { 'data-testid': 'h5-auth-register', novalidate: true },
  }, [
    username.node,
    email.node,
    password.node,
    confirmation.node,
    feedback.error,
    feedback.status,
    submit,
    element('div', { className: 'h5-auth__links is-centered' },
      authLink('已有账号，返回登录', 'h5-auth-to-login', session, 'login')),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = username.input.value.trim();
    const mail = email.input.value.trim();
    if ([...name].length < 2 || [...name].length > 24 || /[<>\s\p{Cc}]/u.test(name)) {
      setFeedback(feedback.error, '用户名需为 2–24 个不含空格的可用字符');
      username.input.focus();
      return;
    }
    if (!EMAIL_RE.test(mail)) {
      setFeedback(feedback.error, '请输入有效邮箱');
      email.input.focus();
      return;
    }
    if (password.input.value.length < 8) {
      setFeedback(feedback.error, '密码至少需要 8 个字符');
      password.input.focus();
      return;
    }
    if (password.input.value !== confirmation.input.value) {
      setFeedback(feedback.error, '两次输入的密码不一致');
      confirmation.input.focus();
      return;
    }
    await runSessionAction({
      form,
      submit,
      session,
      method: 'registerAccount',
      payload: { username: name, email: mail, password: password.input.value },
      feedback,
      idleText: '注册并进入联机',
      busyText: '正在创建账号…',
      successText: '注册成功，正在进入大厅…',
      failureText: '注册失败，请稍后重试',
    });
  });
  return { form, focus: username.input };
}

function resetRequestForm({ state, session, feedback }) {
  const data = stateData(state);
  const email = inputField({
    label: '注册邮箱',
    testId: 'h5-reset-email',
    type: 'email',
    value: data.email || '',
    autocomplete: 'email',
    inputmode: 'email',
    maxlength: 254,
    placeholder: '输入注册邮箱',
  });
  const submit = button('发送重置邮件', {
    className: 'h5-primary-button h5-auth__submit',
    attrs: { type: 'submit', 'data-testid': 'h5-reset-request-submit' },
  });
  const requestStatus = element('p', {
    className: 'h5-auth__request-status',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'h5-reset-request-status' },
  });
  const form = element('form', {
    className: 'h5-auth__form is-reset-request',
    attrs: { 'data-testid': 'h5-auth-reset-request', novalidate: true },
  }, [
    email.node,
    element('p', { className: 'h5-auth__hint', text: '若邮箱已注册，我们会发送一次性重置链接。' }),
    feedback.error,
    feedback.status,
    requestStatus,
    submit,
    element('div', { className: 'h5-auth__links is-centered' },
      authLink('返回登录', 'h5-auth-to-login', session, 'login')),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mail = email.input.value.trim();
    if (!EMAIL_RE.test(mail)) {
      setFeedback(feedback.error, '请输入有效邮箱');
      email.input.focus();
      return;
    }
    const ok = await runSessionAction({
      form,
      submit,
      session,
      method: 'requestPasswordReset',
      payload: { email: mail },
      feedback,
      idleText: '发送重置邮件',
      busyText: '正在发送…',
      successText: '若邮箱已注册，重置邮件将很快送达。',
      failureText: '暂时无法发送，请稍后重试',
    });
    if (ok) requestStatus.textContent = '请检查收件箱和垃圾邮件；链接仅可使用一次。';
  });
  return { form, focus: email.input };
}

function resetConfirmForm({ state, session, feedback }) {
  const data = stateData(state);
  const tokenValue = String(data.resetToken || data.token || state.resetToken || '');
  const token = element('input', {
    attrs: { type: 'hidden', value: tokenValue, 'data-testid': 'h5-reset-token' },
  });
  const password = inputField({
    label: '新密码',
    testId: 'h5-reset-password',
    type: 'password',
    autocomplete: 'new-password',
    minlength: 8,
    maxlength: 128,
    placeholder: '至少 8 个字符',
  });
  const confirmation = inputField({
    label: '确认新密码',
    testId: 'h5-reset-password-confirm',
    type: 'password',
    autocomplete: 'new-password',
    minlength: 8,
    maxlength: 128,
    placeholder: '再次输入新密码',
  });
  const submit = button('确认重置密码', {
    className: 'h5-primary-button h5-auth__submit',
    attrs: { type: 'submit', 'data-testid': 'h5-reset-submit' },
  });
  const form = element('form', {
    className: 'h5-auth__form is-reset-confirm',
    attrs: { 'data-testid': 'h5-auth-reset-confirm', novalidate: true },
  }, [
    token,
    element('p', {
      className: `h5-auth__token-state${tokenValue ? ' is-ready' : ' is-missing'}`,
      text: tokenValue ? '重置链接已验证，请设置新密码。' : '链接缺少验证信息，请重新申请。',
    }),
    password.node,
    confirmation.node,
    feedback.error,
    feedback.status,
    submit,
    element('div', { className: 'h5-auth__links is-centered' },
      authLink('返回登录', 'h5-auth-to-login', session, 'login')),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const resetToken = token.value.trim();
    if (!resetToken) {
      setFeedback(feedback.error, '重置链接无效，请重新申请');
      return;
    }
    if (password.input.value.length < 8) {
      setFeedback(feedback.error, '新密码至少需要 8 个字符');
      password.input.focus();
      return;
    }
    if (password.input.value !== confirmation.input.value) {
      setFeedback(feedback.error, '两次输入的新密码不一致');
      confirmation.input.focus();
      return;
    }
    await runSessionAction({
      form,
      submit,
      session,
      method: 'confirmPasswordReset',
      payload: { token: resetToken, newPassword: password.input.value },
      feedback,
      idleText: '确认重置密码',
      busyText: '正在重置…',
      successText: '密码已重置，请返回登录。',
      failureText: '重置链接无效或已过期',
    });
  });
  return { form, focus: password.input };
}

const VIEW_META = Object.freeze({
  quick: { eyebrow: 'DEVICE QUICK LOGIN', title: '一键登录', description: '本设备只需昵称' },
  login: { eyebrow: 'ONLINE ACCOUNT', title: '登录联机账号', description: '用户名和邮箱均可登录' },
  register: { eyebrow: 'CREATE ACCOUNT', title: '注册账号', description: '用户名 · 密码 · 邮箱' },
  'reset-request': { eyebrow: 'ACCOUNT RECOVERY', title: '找回密码', description: '通过注册邮箱重置' },
  'reset-confirm': { eyebrow: 'NEW PASSWORD', title: '设置新密码', description: '完成后旧会话将失效' },
});

export function createH5AuthView({ state = {}, session = null, onBack = null } = {}) {
  const view = authViewFor(state);
  const meta = VIEW_META[view];
  const feedback = feedbackNodes(state);
  const builder = ({
    quick: quickLoginForm,
    login: loginForm,
    register: registerForm,
    'reset-request': resetRequestForm,
    'reset-confirm': resetConfirmForm,
  })[view];
  const content = builder({ state, session, feedback });
  const externallyBusy = Boolean(
    state.authPending || state.authBusy || state.busy || stateData(state).busy,
  );
  if (externallyBusy) {
    content.form.setAttribute('aria-busy', 'true');
    for (const control of content.form.querySelectorAll('input, button')) control.disabled = true;
  }

  const back = button('返回', {
    className: 'h5-auth__back',
    attrs: { 'data-testid': 'h5-auth-back', 'aria-label': '返回游戏首页' },
    on: { click: () => onBack?.() },
  });
  if (typeof onBack !== 'function') back.hidden = true;

  const screen = element('div', {
    className: 'h5-screen h5-auth',
    attrs: {
      'data-testid': 'h5-auth',
      'data-auth-view': view,
      'aria-busy': externallyBusy ? 'true' : 'false',
    },
  }, [
    element('header', { className: 'h5-auth__topbar' }, [
      back,
      element('strong', { text: '群英决 · 联网账号' }),
      element('span', { text: '登录后进入大厅' }),
    ]),
    element('main', { className: 'h5-auth__body' }, [
      element('section', { className: 'h5-auth__brand', attrs: { 'aria-label': '账号功能说明' } }, [
        element('span', { className: 'h5-auth__seal', text: '群' }),
        element('p', { className: 'h5-auth__eyebrow', text: 'HEROES SHOWDOWN' }),
        element('h1', { text: '一号通行' }),
        element('p', { text: '联机资料、战绩与扑克统计随账号同步。' }),
        element('small', { text: '邮箱不会展示给其他玩家' }),
      ]),
      element('section', {
        className: 'h5-auth__panel',
        attrs: { 'aria-labelledby': 'h5-auth-title' },
      }, [
        element('header', { className: 'h5-auth__heading' }, [
          element('div', {}, [
            element('p', { className: 'h5-auth__eyebrow', text: meta.eyebrow }),
            element('h2', { text: meta.title, attrs: { id: 'h5-auth-title' } }),
          ]),
          element('span', { text: meta.description }),
        ]),
        element('div', { className: 'h5-auth__scroll' }, [
          content.form,
          element('p', { className: 'h5-auth__privacy', text: '账号凭据仅用于验证，不会向房间玩家公开。' }),
        ]),
      ]),
    ]),
  ]);
  queueMicrotask(() => {
    if (screen.isConnected && !externallyBusy && !screen.matches(':focus-within')) content.focus?.focus();
  });
  return screen;
}

export function mountH5AuthView({ root, state = {}, session = null, onBack = null } = {}) {
  if (!root) throw new TypeError('H5 auth view requires a root element');
  let screen = createH5AuthView({ state, session, onBack });
  clear(root, screen);
  return {
    get element() { return screen; },
    update(nextState = {}) {
      screen = createH5AuthView({ state: nextState, session, onBack });
      clear(root, screen);
      return screen;
    },
    destroy() {
      if (screen.isConnected) screen.remove();
    },
  };
}
