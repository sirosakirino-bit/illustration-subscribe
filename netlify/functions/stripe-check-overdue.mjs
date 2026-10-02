// 毎日自動実行されるスケジュール関数。
// 「初回の支払い失敗から約2週間経過しても支払いが完了しない場合は自動的に退会扱いとなる」
// というルールを、Stripe側のダンニング設定に依存せず確実に実行するための安全網。
// 実際の退会確定（is_removed=true 等）は、ここでStripeのサブスクリプションをキャンセルした結果
// 届く customer.subscription.deleted Webhookの中で行われる（stripe-webhook.mjs参照）。
import { getDb } from './_lib/db.mjs';
import { getStripe } from './_lib/stripe.mjs';
import { notifyAdmin, escapeHtml } from './_lib/email.mjs';

const OVERDUE_DAYS = 14;

export async function handler() {
  const db = getDb();
  try {
    const overdue = await db.sql`
      SELECT * FROM members
      WHERE payment_status = 'past_due'
        AND is_removed = false
        AND payment_failed_at IS NOT NULL
        AND payment_failed_at < now() - (${OVERDUE_DAYS} * INTERVAL '1 day')
    `;

    if (overdue.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ checked: 0 }) };
    }

    const stripe = getStripe();
    let canceledCount = 0;

    for (const member of overdue) {
      try {
        if (member.stripe_subscription_id) {
          // ここでキャンセルすると、Stripeから customer.subscription.deleted が届き、
          // stripe-webhook.mjs 側で is_removed = true 等の実際の退会処理が行われる
          await stripe.subscriptions.cancel(member.stripe_subscription_id);
        } else {
          // Stripeのサブスクリプションがそもそも紐づいていない場合は、ここで直接退会処理をする
          await db.sql`
            UPDATE members SET
              payment_status = 'canceled', is_removed = true, point_balance = 0,
              removed_reason = COALESCE(removed_reason, '支払い遅延による自動退会（未払い2週間経過）'),
              removed_at = COALESCE(removed_at, now())
            WHERE id = ${member.id}
          `;
        }
        canceledCount++;
      } catch (err) {
        console.error('会員ID ' + member.id + ' の自動退会処理に失敗しました:', err);
      }
    }

    notifyAdmin({
      subject: '【自動退会処理】未払い2週間経過により' + canceledCount + '件を自動退会処理しました',
      html:
        '<p>以下の会員について、支払い失敗から' + OVERDUE_DAYS + '日が経過したため自動退会処理を行いました。</p>' +
        '<ul>' + overdue.map(function (m) { return '<li>' + escapeHtml(m.handle_name || m.full_name || m.email) + '</li>'; }).join('') + '</ul>'
    }).catch(function () {});

    return { statusCode: 200, body: JSON.stringify({ checked: overdue.length, canceled: canceledCount }) };
  } catch (err) {
    console.error('自動退会チェックの実行中にエラーが発生しました:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
