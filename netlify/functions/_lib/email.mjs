// メール通知まわりの共通処理（Brevo の Transactional Email API を使用）
// 送信に失敗しても、申請やメッセージ自体の処理は止めないようにする（通知はあくまで「おまけ」）

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_FROM_EMAIL = 'kurageika125@gmail.com';
const DEFAULT_FROM_NAME = 'くらげいかイラストサブスクライブ';
const DEFAULT_ADMIN_EMAIL = 'kurageika125@gmail.com';
const DEFAULT_SITE_URL = 'https://kurageika-illustration-subscription.netlify.app';

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function siteUrl(path) {
  const base = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');
  return base + '/' + String(path || '').replace(/^\//, '');
}

function wrapHtml(bodyHtml) {
  return (
    '<div style="font-family: sans-serif; font-size: 14px; color: #3b454a; line-height: 1.8;">' +
      bodyHtml +
      '<p style="margin-top: 24px; font-size: 11px; color: #9db0b8;">このメールは くらげいかイラストサブスクライブ からの自動通知です。</p>' +
    '</div>'
  );
}

export async function sendEmail({ to, toName, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEYが設定されていないため、メール通知をスキップしました');
    return;
  }
  if (!to) return;

  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          email: process.env.NOTIFY_FROM_EMAIL || DEFAULT_FROM_EMAIL,
          name: process.env.NOTIFY_FROM_NAME || DEFAULT_FROM_NAME
        },
        to: [{ email: to, name: toName || undefined }],
        subject,
        htmlContent: wrapHtml(html)
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(function () { return ''; });
      console.error('メール送信に失敗しました:', res.status, text);
    }
  } catch (err) {
    console.error('メール送信中にエラーが発生しました:', err);
  }
}

// 会員本人（登録メールアドレス）への通知
export function notifyMember(member, opts) {
  if (!member || !member.email) return Promise.resolve();
  var name = member.handle_name || member.full_name || undefined;
  return sendEmail({ to: member.email, toName: name, subject: opts.subject, html: opts.html });
}

// 運営（あなた）への通知
export function notifyAdmin(opts) {
  var adminEmail = process.env.NOTIFY_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  return sendEmail({ to: adminEmail, toName: 'くらげいか', subject: opts.subject, html: opts.html });
}
