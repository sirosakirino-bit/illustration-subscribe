// Stripe連携の共通処理（SDKの初期化・プランとPriceの対応表・顧客の取得/作成）
import Stripe from 'stripe';

let _stripe = null;
export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('STRIPE_SECRET_KEYが設定されていません。Netlifyの環境変数に設定してください。');
    err.statusCode = 500;
    throw err;
  }
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

// プラン（point / monthly）とStripe Price IDの対応表。
// 事前にStripeダッシュボードで「月額11,000円（税込）」「月額27,500円（税込）」の
// 定期支払いPriceを作成し、そのPrice IDを環境変数に設定しておく。
export const PRICE_IDS = {
  point: process.env.STRIPE_PRICE_POINT,
  monthly: process.env.STRIPE_PRICE_MONTHLY
};

export const PLAN_LABELS = { point: 'ポイントプラン', monthly: '月1プラン' };
export const PLAN_AMOUNTS = { point: 11000, monthly: 27500 }; // 税込

export function priceIdForPlan(plan) {
  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    const err = new Error('プラン「' + plan + '」に対応するStripe Price IDが設定されていません（環境変数 STRIPE_PRICE_POINT / STRIPE_PRICE_MONTHLY を確認してください）');
    err.statusCode = 500;
    throw err;
  }
  return priceId;
}

// 翌月1日 0:00（日本時間）のUnixタイムスタンプ（秒）を返す。
// 「月の途中で加入した場合、加入した月は無料となり、プランの適用は翌月1日から」という
// 利用規約の仕様を、Stripeのtrial_end（トライアル終了日）として実装するために使う。
export function nextMonthFirstDayUnix(from) {
  const base = from || new Date();
  // 日本時間 (UTC+9) を基準に「翌月1日 0:00 JST」を求める
  const jstMs = base.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  // 翌月1日 0:00 JST = 翌月1日 前日15:00 UTC
  const nextMonthFirstJstUtc = Date.UTC(y, m + 1, 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return Math.floor(nextMonthFirstJstUtc / 1000);
}

// member行からStripe顧客IDを取得する。なければ新規作成してDBに保存する。
export async function ensureStripeCustomer(db, stripe, member) {
  if (member.stripe_customer_id) return member.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: member.email,
    name: member.handle_name || member.full_name || undefined,
    metadata: { member_id: String(member.id), identity_user_id: member.identity_user_id }
  });

  await db.sql`UPDATE members SET stripe_customer_id = ${customer.id} WHERE id = ${member.id}`;
  return customer.id;
}
