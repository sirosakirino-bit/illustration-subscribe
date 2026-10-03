// Stripeからのwebhookを受け取り、会員の支払い状況(payment_status)をDBに反映する。
// Netlifyの環境変数 STRIPE_WEBHOOK_SECRET に、Stripeダッシュボードで発行したWebhook署名シークレットを設定しておくこと。
// 受け取るイベント（StripeダッシュボードのWebhook設定で以下を選択）：
//   checkout.session.completed, invoice.paid, invoice.payment_failed,
//   customer.subscription.updated, customer.subscription.deleted
import { getDb } from './_lib/db.mjs';
import { getStripe, PLAN_LABELS } from './_lib/stripe.mjs';
import { notifyMember, notifyAdmin, escapeHtml, siteUrl } from './_lib/email.mjs';

async function findMemberBy(db, { memberId, subscriptionId, customerId }) {
  if (memberId) {
    const rows = await db.sql`SELECT * FROM members WHERE id = ${Number(memberId)}`;
    if (rows.length) return rows[0];
  }
  if (subscriptionId) {
    const rows = await db.sql`SELECT * FROM members WHERE stripe_subscription_id = ${subscriptionId}`;
    if (rows.length) return rows[0];
  }
  if (customerId) {
    const rows = await db.sql`SELECT * FROM members WHERE stripe_customer_id = ${customerId}`;
    if (rows.length) return rows[0];
  }
  return null;
}

// 個別オプション料金（商用利用・実績非公開・著作権譲渡・修正回数超過など）の請求書イベントを処理する。
// サブスクの月額課金用のinvoice.paid / invoice.payment_failedハンドラとは完全に分けて扱う
// （obj.subscriptionが無い＝一回限りのInvoice APIで発行した請求書、という判定で振り分ける）。
async function handleOptionInvoiceEvent(db, stripeEvent, obj, succeeded) {
  const msgRows = await db.sql`SELECT * FROM messages WHERE stripe_invoice_id = ${obj.id}`;
  if (msgRows.length === 0) return { statusCode: 200, body: 'option invoice: no matching message (ignored)' };
  const message = msgRows[0];

  const appRows = await db.sql`SELECT * FROM applications WHERE id = ${message.application_id}`;
  if (appRows.length === 0) return { statusCode: 200, body: 'option invoice: application not found (ignored)' };
  const application = appRows[0];

  const member = await findMemberBy(db, { memberId: application.member_id });
  if (!member) return { statusCode: 200, body: 'option invoice: member not found (ignored)' };

  const isNew = await claimEvent(db, {
    stripeEventId: stripeEvent.id, memberId: member.id, eventType: succeeded ? 'option_invoice.paid' : 'option_invoice.payment_failed',
    category: 'option', amount: succeeded ? (obj.amount_paid || 0) : (obj.amount_due || 0), status: succeeded ? '成功' : '失敗',
    description: message.body
  });
  if (!isNew) return { statusCode: 200, body: 'already processed' };

  await db.sql`UPDATE messages SET charge_status = ${succeeded ? 'paid' : 'failed'} WHERE id = ${message.id}`;

  const amountLabel = '¥' + (succeeded ? (obj.amount_paid || 0) : (obj.amount_due || 0)).toLocaleString();
  await db.sql`
    INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
    VALUES (${message.application_id}, 'system', 'system', ${succeeded ? ('お支払い（' + amountLabel + '）が確認できました') : ('お支払い（' + amountLabel + '）の決済に失敗しました')}, false, true)
  `;

  if (succeeded) {
    notifyMember(member, {
      subject: '【お支払い確認】追加料金のお支払いが完了しました',
      html: '<p>' + amountLabel + 'のお支払いが確認できました。ありがとうございます。</p>'
    }).catch(function () {});
    notifyAdmin({
      subject: '【決済完了】' + (member.handle_name || member.full_name || member.email) + ' さんの追加料金（' + amountLabel + '）のお支払いが完了しました',
      html: '<p>内容：' + escapeHtml(message.body || '') + '</p>'
    }).catch(function () {});
  } else {
    notifyMember(member, {
      subject: '【お支払いエラー】追加料金の決済に失敗しました',
      html: '<p>' + amountLabel + 'のご請求について、決済処理に失敗しました。お手数ですが、メッセージ画面の支払いリンクから再度お試しください。</p>'
    }).catch(function () {});
    notifyAdmin({
      subject: '【お支払いエラー】' + (member.handle_name || member.full_name || member.email) + ' さんの追加料金（' + amountLabel + '）の決済に失敗しました',
      html: '<p>内容：' + escapeHtml(message.body || '') + '</p>'
    }).catch(function () {});
  }

  return { statusCode: 200, body: 'ok' };
}

// 既にこのStripeイベントを処理済みかどうかを payment_events への挿入で判定する（Stripeは同じイベントを複数回送ることがある）。
// 挿入できた（＝初めて見るイベント）場合のみ true を返す。
async function claimEvent(db, { stripeEventId, memberId, eventType, category, amount, status, description }) {
  const inserted = await db.sql`
    INSERT INTO payment_events (member_id, stripe_event_id, event_type, category, amount, status, description)
    VALUES (${memberId || null}, ${stripeEventId}, ${eventType}, ${category}, ${amount == null ? null : amount}, ${status}, ${description || null})
    ON CONFLICT (stripe_event_id) DO NOTHING
    RETURNING *
  `;
  return inserted.length > 0;
}

// 顧客のデフォルト支払い方法（カードブランド・下4桁）を取得してDBに反映する（失敗しても致命的ではない）
async function refreshCardInfo(db, stripe, member, customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
    const pm = customer && customer.invoice_settings && customer.invoice_settings.default_payment_method;
    if (pm && pm.card) {
      await db.sql`UPDATE members SET card_brand = ${pm.card.brand || null}, card_last4 = ${pm.card.last4 || null} WHERE id = ${member.id}`;
    }
  } catch (err) {
    console.error('カード情報の取得に失敗しました:', err);
  }
}

export async function handler(event) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRETが設定されていません');
    return { statusCode: 500, body: 'STRIPE_WEBHOOK_SECRET is not configured' };
  }

  const sig = (event.headers && (event.headers['stripe-signature'] || event.headers['Stripe-Signature'])) || '';
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || '');

  let stripe;
  let stripeEvent;
  try {
    stripe = await getStripe();
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe Webhookの署名検証に失敗しました:', err.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  const db = await getDb();

  try {
    const type = stripeEvent.type;
    const obj = stripeEvent.data.object;

    if (type === 'checkout.session.completed') {
      if (obj.mode !== 'subscription') return { statusCode: 200, body: 'ignored (not subscription)' };

      const member = await findMemberBy(db, { memberId: obj.client_reference_id, customerId: obj.customer });
      if (!member) {
        console.error('checkout.session.completed: 対応する会員が見つかりません', obj.client_reference_id, obj.customer);
        return { statusCode: 200, body: 'member not found (ignored)' };
      }

      const isNew = await claimEvent(db, { stripeEventId: stripeEvent.id, memberId: member.id, eventType: type, category: 'subscription', amount: null, status: '成功' });
      if (!isNew) return { statusCode: 200, body: 'already processed' };

      await db.sql`
        UPDATE members SET
          stripe_customer_id = ${obj.customer},
          stripe_subscription_id = ${obj.subscription},
          payment_status = 'active',
          payment_failed_at = NULL,
          cancel_at_period_end = false
        WHERE id = ${member.id}
      `;
      await refreshCardInfo(db, stripe, member, obj.customer);

      notifyMember(member, {
        subject: '【お手続き完了】ご登録ありがとうございます',
        html:
          '<p>お支払い手続きが完了しました。ご登録ありがとうございます！</p>' +
          '<p>ご契約プラン：' + (PLAN_LABELS[member.plan] || member.plan) + '</p>' +
          '<p>加入した月は無料となり、来月1日から月額のご請求が始まります。</p>' +
          '<p><a href="' + siteUrl('mypage.html') + '">マイページを見る</a></p>'
      }).catch(function () {});
      notifyAdmin({
        subject: '【決済完了】' + (member.handle_name || member.full_name || member.email) + ' さんのお支払い手続きが完了しました',
        html: '<p>プラン：' + (PLAN_LABELS[member.plan] || member.plan) + '</p>'
      }).catch(function () {});

      return { statusCode: 200, body: 'ok' };
    }

    if (type === 'invoice.paid') {
      // obj.subscriptionが無い場合は、サブスクの月額課金ではなく一回限りのオプション請求書（Invoice API）
      if (!obj.subscription) return await handleOptionInvoiceEvent(db, stripeEvent, obj, true);

      const subscriptionId = obj.subscription;
      const customerId = obj.customer;
      const member = await findMemberBy(db, { subscriptionId, customerId });
      if (!member) return { statusCode: 200, body: 'member not found (ignored)' };

      const amountPaid = obj.amount_paid || 0; // JPYはゼロ桁通貨のため、そのまま円
      const isNew = await claimEvent(db, { stripeEventId: stripeEvent.id, memberId: member.id, eventType: type, category: 'subscription', amount: amountPaid, status: '成功' });
      if (!isNew) return { statusCode: 200, body: 'already processed' };

      const periodEnd = obj.lines && obj.lines.data && obj.lines.data[0] && obj.lines.data[0].period
        ? new Date(obj.lines.data[0].period.end * 1000).toISOString()
        : null;

      await db.sql`
        UPDATE members SET
          payment_status = 'active',
          payment_failed_at = NULL,
          current_period_end = ${periodEnd}
        WHERE id = ${member.id}
      `;

      // ポイントプランの会員は、実際に金額が発生した請求（トライアル明けの通常請求）ごとに毎月1pt付与する
      if (member.plan === 'point' && amountPaid > 0) {
        await db.sql`UPDATE members SET point_balance = point_balance + 1 WHERE id = ${member.id}`;
      }

      return { statusCode: 200, body: 'ok' };
    }

    if (type === 'invoice.payment_failed') {
      // obj.subscriptionが無い場合は、サブスクの月額課金ではなく一回限りのオプション請求書（Invoice API）
      if (!obj.subscription) return await handleOptionInvoiceEvent(db, stripeEvent, obj, false);

      const subscriptionId = obj.subscription;
      const customerId = obj.customer;
      const member = await findMemberBy(db, { subscriptionId, customerId });
      if (!member) return { statusCode: 200, body: 'member not found (ignored)' };

      const amountDue = obj.amount_due || 0;
      const isNew = await claimEvent(db, { stripeEventId: stripeEvent.id, memberId: member.id, eventType: type, category: 'subscription', amount: amountDue, status: '失敗' });
      if (!isNew) return { statusCode: 200, body: 'already processed' };

      // 最初の支払い失敗日時だけを記録する（2回目以降のリトライ失敗では上書きしない＝自動退会までの2週間の起点を固定する）
      const updated = await db.sql`
        UPDATE members SET
          payment_status = 'past_due',
          payment_failed_at = COALESCE(payment_failed_at, now())
        WHERE id = ${member.id}
        RETURNING *
      `;

      notifyMember(updated[0], {
        subject: '【お支払いエラー】決済処理に失敗しました',
        html:
          '<p>今回のご請求の決済処理に失敗しました。カード情報をご確認のうえ、お支払い方法の更新をお願いいたします。</p>' +
          '<p>以降、Stripeにより自動的に再試行されます。初回の失敗から約2週間、お支払いが完了しない場合は自動的に退会扱いとなりますのでご注意ください。</p>' +
          '<p><a href="' + siteUrl('settings.html') + '">お支払い方法を確認する</a></p>'
      }).catch(function () {});
      notifyAdmin({
        subject: '【お支払いエラー】' + (member.handle_name || member.full_name || member.email) + ' さんの決済が失敗しました',
        html: '<p>金額：' + amountDue + '円</p><p>Stripeの自動リトライ状況は、Stripeダッシュボードでご確認ください。</p>'
      }).catch(function () {});

      return { statusCode: 200, body: 'ok' };
    }

    if (type === 'customer.subscription.updated') {
      const member = await findMemberBy(db, { subscriptionId: obj.id, customerId: obj.customer });
      if (!member) return { statusCode: 200, body: 'member not found (ignored)' };

      const isNew = await claimEvent(db, { stripeEventId: stripeEvent.id, memberId: member.id, eventType: type, category: 'subscription', amount: null, status: '更新' });
      if (!isNew) return { statusCode: 200, body: 'already processed' };

      let paymentStatus;
      if (obj.pause_collection) {
        paymentStatus = 'paused';
      } else if (obj.status === 'active' || obj.status === 'trialing') {
        paymentStatus = 'active';
      } else if (obj.status === 'past_due' || obj.status === 'unpaid') {
        paymentStatus = 'past_due';
      } else if (obj.status === 'canceled') {
        paymentStatus = 'canceled';
      } else {
        paymentStatus = member.payment_status; // 不明な場合は現状維持
      }

      const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : member.current_period_end;

      await db.sql`
        UPDATE members SET
          payment_status = ${paymentStatus},
          cancel_at_period_end = ${!!obj.cancel_at_period_end},
          current_period_end = ${periodEnd}
        WHERE id = ${member.id}
      `;
      await refreshCardInfo(db, stripe, member, obj.customer);

      return { statusCode: 200, body: 'ok' };
    }

    if (type === 'customer.subscription.deleted') {
      const member = await findMemberBy(db, { subscriptionId: obj.id, customerId: obj.customer });
      if (!member) return { statusCode: 200, body: 'member not found (ignored)' };

      const isNew = await claimEvent(db, { stripeEventId: stripeEvent.id, memberId: member.id, eventType: type, category: 'subscription', amount: null, status: '解約' });
      if (!isNew) return { statusCode: 200, body: 'already processed' };

      // 支払い遅延による自動退会か、それ以外（通常の退会予告の満了・運営による強制解約）かを区別する
      const reason = member.is_removed
        ? member.removed_reason // 既に強制退会等で理由がついている場合はそのまま
        : (member.payment_status === 'past_due' ? '支払い遅延による自動退会（未払い2週間経過）' : '退会（Stripeサブスクリプション終了）');

      await db.sql`
        UPDATE members SET
          payment_status = 'canceled',
          is_removed = true,
          removed_reason = COALESCE(removed_reason, ${reason}),
          removed_at = COALESCE(removed_at, now()),
          point_balance = 0
        WHERE id = ${member.id}
      `;
      await db.sql`
        UPDATE applications SET status = 'キャンセル', updated_at = now()
        WHERE member_id = ${member.id} AND status IN ('ヒアリング中', '制作中')
      `;

      notifyMember(member, {
        subject: '【退会のお知らせ】ご利用ありがとうございました',
        html: '<p>サブスクリプションが終了し、退会処理が完了しました。ご利用いただきありがとうございました。</p>'
      }).catch(function () {});
      notifyAdmin({
        subject: '【退会】' + (member.handle_name || member.full_name || member.email) + ' さんが退会しました',
        html: '<p>理由：' + escapeHtml(reason) + '</p>'
      }).catch(function () {});

      return { statusCode: 200, body: 'ok' };
    }

    // それ以外のイベント種別は特に処理しない
    return { statusCode: 200, body: 'ignored (unhandled event type)' };
  } catch (err) {
    console.error('Stripe Webhookの処理中にエラーが発生しました:', err);
    // 500を返すとStripe側がリトライしてくれるため、意図せぬ一時エラー（DB接続エラー等）はリトライに任せる
    return { statusCode: 500, body: 'internal error' };
  }
}
