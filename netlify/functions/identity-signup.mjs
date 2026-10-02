// Netlify Identityの「会員登録（signup）」イベントで自動的に呼ばれる関数
// ファイル名が identity-signup であることで、Netlifyが自動的にこの関数を呼び出します。
// ここでの処理に失敗しても、会員登録そのものは必ず続行させる（常に200を返す）。
import { notifyAdmin, escapeHtml } from './_lib/email.mjs';

export async function handler(event) {
  try {
    var payload = JSON.parse(event.body || '{}');
    var user = payload.user || {};
    var meta = user.user_metadata || {};
    var name = meta.handle_name || meta.full_name || user.email || '（お名前不明）';

    await notifyAdmin({
      subject: '【Xovy Studio】新しい会員登録がありました',
      html:
        '<p>新しい会員登録がありました。</p>' +
        '<p>' +
          'お名前：' + escapeHtml(name) + '<br>' +
          'メールアドレス：' + escapeHtml(user.email || '') +
        '</p>' +
        '<p>管理画面の会員一覧からご確認ください。</p>'
    });
  } catch (err) {
    console.error('会員登録通知の送信でエラーが発生しました:', err);
  }

  // 通知の成否に関わらず、会員登録処理は必ずそのまま続行させる
  return { statusCode: 200, body: JSON.stringify({}) };
}
