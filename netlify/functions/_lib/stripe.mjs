// Stripe連携の共通処理（SDKの初期化・プランとPriceの対応表・顧客の取得/作成）
// ※ 'stripe' パッケージはここでは読み込まず、getStripe()が実際に呼ばれた時に動的import()で読み込む。
//    トップレベルで固定的にimportすると、万が一そのパッケージが正しくインストールされていない
//    環境では、このファイルをimportしているだけの関数（会員一覧・メッセージ機能など、
//    Stripeを全く使わない処理）まで巻き添えで丸ごと動かなくなってしまうため。

let _stripe = null;
export async function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('STRIPE_SECRET_KEYが設定されていません。Netlifyの環境変数に設定してください。');
    err.statusCode = 500;
    throw err;
  }
  const { default: Stripe } = await import('stripe');
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

// 商用利用・著作権譲渡・実績非公開・修正回数超過などの個別オプション料金を、
// サブスクの月額課金とは別枠の「一回限りの請求書（Invoice）」として作成する。
// collection_method: 'send_invoice' を使うため、Stripe側からの自動引き落としは行われず、
// 会員がhosted_invoice_url（請求書の支払いページ）を開いて能動的に支払う形になる。
export async function createOptionInvoice(stripe, customerId, amountYen, description) {
  await stripe.invoiceItems.create({
    customer: customerId,
    amount: Math.round(amountYen), // JPYはゼロ桁通貨のため、そのまま円の整数
    currency: 'jpy',
    description: description
  });

  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 14,
    auto_advance: false,
    metadata: { kind: 'option_charge' }
  });

  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  return { id: finalized.id, hostedInvoiceUrl: finalized.hosted_invoice_url };
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
