// 新規会員登録後、決済（Stripe Checkout）を開始するための関数。
// signup-payment.html から呼ばれ、作成したCheckout SessionのURLを返す。クライアント側はそのURLへ遷移する。
import { getDb } from './_lib/db.mjs';
import { requireUser, jsonResponse } from './_lib/auth.mjs';
import { getStripe, priceIdForPlan, nextMonthFirstDayUnix, ensureStripeCustomer } from './_lib/stripe.mjs';

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'このメソッドは使えません' });

  const db = getDb();
  try {
    const user = requireUser(context);
    const memberRows = await db.sql`SELECT * FROM members WHERE identity_user_id = ${user.sub}`;
    if (memberRows.length === 0) return jsonResponse(404, { error: '会員情報が見つかりません' });
    const member = memberRows[0];

    if (member.is_removed) {
      return jsonResponse(403, { error: 'このアカウントはご利用いただけません。詳しくは運営までお問い合わせください。' });
    }
    if (member.payment_status === 'active' && member.stripe_subscription_id) {
      return jsonResponse(400, { error: 'すでにお支払い手続きは完了しています。' });
    }

    const plan = member.plan === 'monthly' ? 'monthly' : 'point';
    const stripe = getStripe();
    const customerId = await ensureStripeCustomer(db, stripe, member);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(member.id),
      line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
      // 加入した月は無料、プランの適用（課金開始）は翌月1日から。
      // Stripeの「トライアル」として実装し、トライアル終了日を翌月1日0:00(JST)に設定する。
      subscription_data: {
        trial_end: nextMonthFirstDayUnix(),
        metadata: { member_id: String(member.id), plan: plan }
      },
      allow_promotion_codes: false,
      success_url: (process.env.SITE_URL || 'https://xovy-studio.netlify.app') + '/mypage.html?checkout=success',
      cancel_url: (process.env.SITE_URL || 'https://xovy-studio.netlify.app') + '/signup-payment.html?checkout=cancel'
    });

    return jsonResponse(200, { url: session.url });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'Stripe Checkoutセッションの作成に失敗しました' });
  }
}
