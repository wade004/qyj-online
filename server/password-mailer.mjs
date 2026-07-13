const DEFAULT_PUBLIC_APP_URL = 'http://127.0.0.1:8080/';

function resetLink(publicAppUrl, token) {
  const url = new URL(publicAppUrl || DEFAULT_PUBLIC_APP_URL);
  url.searchParams.set('resetToken', token);
  return url.href;
}

function maskEmail(email) {
  const [name = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

/**
 * Password mail delivery uses a small JSON webhook contract so deployments can
 * connect any mail provider without putting provider SDKs in the game server.
 * In development, messages stay in an in-memory outbox and the reset link is
 * printed to the local server terminal.
 */
export function createPasswordResetMailer({
  webhookUrl = process.env.QYJ_MAIL_WEBHOOK_URL || '',
  webhookToken = process.env.QYJ_MAIL_WEBHOOK_TOKEN || '',
  from = process.env.QYJ_MAIL_FROM || '群英决 <no-reply@localhost>',
  publicAppUrl = process.env.PUBLIC_APP_URL || DEFAULT_PUBLIC_APP_URL,
  environment = process.env.NODE_ENV || 'development',
  fetchImpl = globalThis.fetch,
} = {}) {
  const outbox = [];
  if (!webhookUrl && environment === 'production') {
    throw new Error('生产环境尚未配置 QYJ_MAIL_WEBHOOK_URL');
  }

  async function send({ to, token, expiresAt }) {
    const link = resetLink(publicAppUrl, token);
    const numericExpiry = Number(expiresAt);
    const parsedExpiry = Number.isFinite(numericExpiry) ? numericExpiry : Date.parse(expiresAt);
    const expiresMinutes = Number.isFinite(parsedExpiry)
      ? Math.max(1, Math.ceil((parsedExpiry - Date.now()) / 60_000))
      : 15;
    const subject = '《群英决》密码重置';
    const text = [
      '你正在重置《群英决》联机账号密码。',
      `请在 ${expiresMinutes} 分钟内打开以下链接：`,
      link,
      '',
      '如果不是你本人操作，请忽略此邮件。',
    ].join('\n');
    const message = { to, from, subject, text, resetUrl: link, token, expiresAt };

    if (!webhookUrl) {
      outbox.push(Object.freeze({ ...message }));
      console.log(`[DevMail] ${maskEmail(to)} 密码重置链接：${link}`);
      return { delivered: true, development: true };
    }
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持邮件 Webhook');
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(webhookToken ? { authorization: `Bearer ${webhookToken}` } : {}),
      },
      body: JSON.stringify({ to, from, subject, text }),
    });
    if (!response.ok) throw new Error(`邮件服务返回 ${response.status}`);
    return { delivered: true, development: false };
  }

  return Object.freeze({ send, outbox });
}

export { resetLink as passwordResetLink };
