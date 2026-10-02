// Stripeカスタマーポータル（カード情報の変更・請求書の確認など）を開くためのセッションを作成する関数。
// settings.html の「Stripeで変更する」ボタンから呼ばれる。
import { getDb } from './_lib/db.mjs';
import { requireUser, jsonResponse } from './_lib/auth.mjs';
import { getStripe } from './_lib/stripe.mjs';

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'このメソッドは使えません' });

  const db = getDb();
  try {
    const user = requireUser(context);
    const memberRows = await db.sql`SELECT * FROM members WHERE identity_user_id = ${user.sub}`;
    if (memberRows.length === 0) return jsonResponse(404, { error: '会員情報が見つかりません' });
    const member = memberRows[0];

    if (!member.stripe_customer_id) {
      return jsonResponse(400, { error: 'まだお支払い情報が登録されていません。先にお支払い手続きを完了してください。' });
    }

    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id,
      return_url: (process.env.SITE_URL || 'https://xovy-studio.netlify.app') + '/settings.html'
    });

    return jsonResponse(200, { url: session.url });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'カスタマーポータルの作成に失敗しました' });
  }
}
