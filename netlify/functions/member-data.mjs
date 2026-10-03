import { getDb } from './_lib/db.mjs';
import { requireUser, jsonResponse } from './_lib/auth.mjs';
import { notifyAdmin, notifyMember, escapeHtml, siteUrl } from './_lib/email.mjs';
import { computeCapacity } from './_lib/capacity.mjs';
import { getStripe, priceIdForPlan } from './_lib/stripe.mjs';

const PLAN_LABELS = { point: 'ポイントプラン', monthly: '月1プラン' };
const PLAN_AMOUNTS = { point: 11000, monthly: 27500 }; // 税込

// ============================================================================
// テスト開発中のみ使うフラグ：申請件数の上限チェック・ポイント残高チェック・ポイント消費を無効化する。
// 本番公開前に必ず false に戻すこと（このフラグをfalseにするだけで、元の制限ありの挙動に戻ります）。
// ============================================================================
const TEST_MODE_SKIP_LIMITS = true;

function memberLabel(member) {
  return member.handle_name || member.full_name || member.email;
}

// 管理者向けメール通知で、オプションの選択状況をまとめて表示するためのヘルパー
function formatOptionsForEmail(optCommercial, optHidden, optCopyright) {
  var tags = [];
  if (optCommercial) tags.push('商用利用（＋20,000円＋税10%）');
  if (optHidden) tags.push('実績非公開（＋50,000円＋税10%）');
  if (optCopyright) tags.push('著作権譲渡（＋100,000円＋税10%）');
  return tags.length ? tags.join('／') : 'なし';
}

const MENU_TITLES = {
  1: 'ミニキャラ／SNSアイコン等（1pt・メニュー選択）',
  2: 'バストアップ＋簡易背景（2pt・メニュー選択）',
  3: '腰上＋背景／人物2人まで（3pt・メニュー選択）'
};

// 正式受付（見積もり承諾）の直後に自動送信する、今後の制作の流れの案内文。
// 納期目安はプラン（ポイントプラン／月1プラン）によって異なるため、利用規約の記載に合わせて出し分ける。
function buildProductionFlowMessage(kind) {
  const deadlineLine = kind === 'monthly'
    ? '納期の目安：正式受付日から1ヶ月以内です（ヒアリングの状況やデザイン内容によっては、目安から納品がずれることがあります）。'
    : '納期の目安：正式受付日から2ヶ月以内です（ヒアリングの状況やデザイン内容によっては、目安から納品がずれることがあります）。納期のご指定は基本的に承っておりません。';

  return (
    'ここから制作を進めてまいります。今後の流れは以下の通りです！\n\n' +
    '１￤ラフ提案\n依頼内容を元に、全体の大まかなラフを制作します。\n\n' +
    '　↕　修正回数無制限\n' +
    '　　  ※ただし、何度も修正を重ねられた場合や大幅なリテイク、修正不可の段階での修正、書き直しについては追加料金（+10,000円＋消費税10%）が発生します。\n\n' +
    '２￤デザインの確定\n\n' +
    '　↓　以降修正不可\n\n' +
    '３￤イラスト・デザイン制作開始(本制作)\nラフを元に清書いたします。\n\n' +
    '４￤納品\nイラストに致命的な不備がないか確認していただきます。\n問題がなければデータを納品させていただき、完了となります。\n\n' +
    deadlineLine + '\n\n' +
    '基本的には、1/2/3/4の段階ごとに確認のご連絡をいたします。\n' +
    '修正のご希望があれば、こちらのメッセージでいつでもお気軽にお知らせください🌱\n\n' +
    'それでは、どうぞよろしくお願いいたします🙇‍♀️✨'
  );
}

async function ensureMember(db, user) {
  const existing = await db.sql`SELECT * FROM members WHERE identity_user_id = ${user.sub}`;
  if (existing.length > 0) return existing[0];

  const meta = user.user_metadata || {};
  const inserted = await db.sql`
    INSERT INTO members (identity_user_id, email, full_name, handle_name, zip, prefecture, address1, address2, usage_type, sns_x, sns_youtube, sns_twitch, plan)
    VALUES (
      ${user.sub}, ${user.email}, ${meta.full_name || null}, ${meta.handle_name || null},
      ${meta.zip || null}, ${meta.prefecture || null}, ${meta.address1 || null}, ${meta.address2 || null},
      ${meta.usage_type || null}, ${meta.sns_x || null}, ${meta.sns_youtube || null}, ${meta.sns_twitch || null},
      ${meta.plan || 'point'}
    )
    RETURNING *
  `;
  return inserted[0];
}

export async function handler(event, context) {
  const db = await getDb();
  try {
    const user = requireUser(context);
    const member = await ensureMember(db, user);

    if (member.is_removed) {
      const err = new Error('このアカウントはご利用いただけません。詳しくは運営までお問い合わせください。');
      err.statusCode = 403;
      throw err;
    }

    if (event.httpMethod === 'GET') {
      const query = event.queryStringParameters || {};

      // ---- 申請ごとのメッセージスレッド表示 ----
      if (query.thread) {
        const applicationId = Number(query.thread);
        const appRows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId} AND member_id = ${member.id}`;
        if (appRows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });

        const messages = await db.sql`SELECT * FROM messages WHERE application_id = ${applicationId} ORDER BY created_at ASC`;

        // 運営からのメッセージを既読にする
        await db.sql`
          UPDATE messages SET read_by_member = true
          WHERE application_id = ${applicationId} AND sender != 'member' AND read_by_member = false
        `;

        return jsonResponse(200, { member, application: appRows[0], messages });
      }

      // ---- 通常のマイページ表示（申請一覧・未読件数つき） ----
      const applications = await db.sql`
        SELECT a.*,
          (SELECT COUNT(*) FROM messages msg WHERE msg.application_id = a.id AND msg.sender != 'member' AND msg.read_by_member = false)::int AS unread_count
        FROM applications a
        WHERE a.member_id = ${member.id}
        ORDER BY a.created_at DESC
      `;

      // 直近30日以内に配信された全体お知らせ（マイページでの告知表示用）
      const recentAnnouncements = await db.sql`
        SELECT id, subject, created_at FROM announcements
        WHERE created_at > now() - interval '30 days'
        ORDER BY created_at DESC
        LIMIT 3
      `;

      // ポイントプランの今月の受付枠（残り）。メニュー申請画面(apply.html)の上部表示用
      const capacity = await computeCapacity(db);

      // 月1プランの定員（2名）。プラン変更画面(plan-change.html)でのポイント→月1変更可否の判定用
      const monthlyCountRows = await db.sql`SELECT COUNT(*)::int AS c FROM members WHERE plan = 'monthly' AND is_removed = false`;
      const monthlyPlanFull = monthlyCountRows[0].c >= 2;

      return jsonResponse(200, { member, applications, recentAnnouncements, capacity, monthlyPlanFull });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      // お支払いが完了していない（決済未完了・支払い失敗中・休止中・解約済み）会員は、
      // 新しいご依頼（ポイント使用・特殊な依頼・月1プランの今月のご依頼）を送れないようにする
      // （TEST_MODE_SKIP_LIMITS中はこの制限を無視する）
      const PAYMENT_GATED_ACTIONS = ['submit-menu', 'submit-consult', 'submit-monthly'];
      if (!TEST_MODE_SKIP_LIMITS && PAYMENT_GATED_ACTIONS.includes(action) && member.payment_status !== 'active') {
        const messages = {
          pending: 'お支払い手続きがまだ完了していないため、現在は新しいご依頼をお送りいただけません。お支払いを完了してください。',
          past_due: 'お支払いが確認できていないため、現在は新しいご依頼をお送りいただけません。お支払い方法をご確認ください。',
          paused: '現在サブスクリプションが休止中のため、新しいご依頼をお送りいただけません。',
          canceled: 'サブスクリプションが解約済みのため、新しいご依頼をお送りいただけません。'
        };
        return jsonResponse(400, { error: messages[member.payment_status] || 'お支払い状況をご確認ください。' });
      }

      // 会員1人につき、同時に進行できる申請（ヒアリング中・制作中）は1件までとする
      // （TEST_MODE_SKIP_LIMITS中はこの制限を無視する）
      if (!TEST_MODE_SKIP_LIMITS && (action === 'submit-menu' || action === 'submit-consult')) {
        const active = await db.sql`
          SELECT id FROM applications
          WHERE member_id = ${member.id} AND status IN ('ヒアリング中', '制作中')
        `;
        if (active.length > 0) {
          return jsonResponse(400, { error: '現在進行中のご依頼（ヒアリング中・制作中）が1件あるため、新しい申請はできません。対応完了後にもう一度お申し込みください。' });
        }
      }

      if (action === 'submit-menu') {
        const pt = Number(body.point_cost);
        if (!MENU_TITLES[pt]) return jsonResponse(400, { error: '不正なメニューです' });
        const notes = (body.notes || '').trim();
        if (!notes) return jsonResponse(400, { error: 'ご要望メモの入力は必須です' });

        if (!TEST_MODE_SKIP_LIMITS) {
          if (member.point_balance < pt) return jsonResponse(400, { error: 'ポイントが不足しています' });

          const capacity = await computeCapacity(db);
          if (capacity.remaining < pt) {
            return jsonResponse(400, { error: '今月のポイントプラン受付枠が不足しているため、現在は受付できません。枠が回復するまでお待ちください。' });
          }
        }

        const optCommercial = !!body.opt_commercial;
        const optHidden = !!body.opt_hidden;
        const optCopyright = !!body.opt_copyright;

        const updatedMembers = TEST_MODE_SKIP_LIMITS
          ? [member]
          : await db.sql`UPDATE members SET point_balance = point_balance - ${pt} WHERE id = ${member.id} RETURNING *`;
        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_cost, status, opt_commercial, opt_hidden, opt_copyright)
          VALUES (${member.id}, 'menu', ${MENU_TITLES[pt]}, ${notes}, ${pt}, '制作中', ${optCommercial}, ${optHidden}, ${optCopyright}) RETURNING *`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${inserted[0].id}, 'member', 'text', ${notes}, true, false)
        `;
        notifyAdmin({
          subject: '【新しい申請】' + memberLabel(member) + ' さんから制作メニューの申請がありました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、新しい申請がありました。</p>' +
            '<p>プラン：' + (PLAN_LABELS[member.plan] || member.plan) + '</p>' +
            '<p>メニュー：' + escapeHtml(inserted[0].title) + '（ヒアリング不要・即時受付）</p>' +
            '<p>ポイント数：' + pt + 'pt</p>' +
            '<p>ご要望メモ：<br>' + escapeHtml(notes).replace(/\n/g, '<br>') + '</p>' +
            '<p>オプション：' + formatOptionsForEmail(optCommercial, optHidden, optCopyright) + '</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + inserted[0].id) + '">管理画面で確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { member: updatedMembers[0], application: inserted[0] });
      }

      if (action === 'submit-consult') {
        const details = (body.details || '').trim();
        if (!details) return jsonResponse(400, { error: 'ご依頼内容の入力は必須です' });
        if (!TEST_MODE_SKIP_LIMITS) {
          const pending = await db.sql`
            SELECT id FROM applications WHERE member_id = ${member.id} AND kind = 'consult' AND status = 'ヒアリング中'`;
          if (pending.length > 0) return jsonResponse(400, { error: 'すでに相談中（ヒアリング中）の申請があります。回答・正式受付が済んでから、次のご相談をお送りください。' });
        }

        const optCommercial = !!body.opt_commercial;
        const optHidden = !!body.opt_hidden;
        const optCopyright = !!body.opt_copyright;

        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_estimate, status, opt_commercial, opt_hidden, opt_copyright)
          VALUES (${member.id}, 'consult', ${body.title || '特殊な依頼のご相談'}, ${details}, ${body.point_estimate || null}, 'ヒアリング中', ${optCommercial}, ${optHidden}, ${optCopyright}) RETURNING *`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${inserted[0].id}, 'member', 'text', ${details}, true, false)
        `;
        notifyAdmin({
          subject: '【新しい申請】' + memberLabel(member) + ' さんから特殊な依頼のご相談がありました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、特殊な依頼のご相談がありました。</p>' +
            '<p>プラン：' + (PLAN_LABELS[member.plan] || member.plan) + '</p>' +
            '<p>タイトル：' + escapeHtml(inserted[0].title) + '</p>' +
            '<p>希望ポイント数の目安：' + escapeHtml(body.point_estimate || '相談中') + '</p>' +
            '<p>依頼内容：<br>' + escapeHtml(details).replace(/\n/g, '<br>') + '</p>' +
            '<p>オプション：' + formatOptionsForEmail(optCommercial, optHidden, optCopyright) + '</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + inserted[0].id) + '">管理画面で確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { member, application: inserted[0] });
      }

      // ---- 月1プラン：今月のご依頼を送信する（保有ポイントは使わず、基礎2pt相当を消費） ----
      if (action === 'submit-monthly') {
        if (member.plan !== 'monthly') return jsonResponse(400, { error: '月1プランの会員のみご利用いただけます' });
        const details = (body.details || '').trim();
        if (!details) return jsonResponse(400, { error: 'ご依頼内容の入力は必須です' });

        if (!TEST_MODE_SKIP_LIMITS) {
          const active = await db.sql`
            SELECT id FROM applications WHERE member_id = ${member.id} AND kind = 'monthly' AND status IN ('ヒアリング中', '制作中')`;
          if (active.length > 0) return jsonResponse(400, { error: '現在進行中の今月のご依頼が1件あるため、新しい申請はできません。対応完了後にもう一度お申し込みください。' });

          const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
          const thisMonth = await db.sql`
            SELECT id FROM applications
            WHERE member_id = ${member.id} AND kind = 'monthly' AND status != 'キャンセル' AND created_at >= ${monthStart}`;
          if (thisMonth.length > 0) return jsonResponse(400, { error: '今月分のご依頼はすでにお送りいただいています。来月またお申し込みください。' });
        }

        const wantsExtra = !!body.extra_purchase;
        const optCommercial = !!body.opt_commercial;
        const optHidden = !!body.opt_hidden;
        const optCopyright = !!body.opt_copyright;

        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_estimate, status, opt_commercial, opt_hidden, opt_copyright)
          VALUES (${member.id}, 'monthly', '今月のご依頼', ${details}, ${wantsExtra ? '3pt' : '2pt'}, 'ヒアリング中', ${optCommercial}, ${optHidden}, ${optCopyright}) RETURNING *`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${inserted[0].id}, 'member', 'text', ${details}, true, false)
        `;
        notifyAdmin({
          subject: '【新しい申請】' + memberLabel(member) + ' さんから今月のご依頼がありました（月1プラン）',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、今月のご依頼がありました。</p>' +
            '<p>基礎枠：2pt相当' + (wantsExtra ? '＋追加購入1pt（計3pt相当・追加料金+10,000円＋消費税10%）' : '（追加購入なし）') + '</p>' +
            '<p>依頼内容：<br>' + escapeHtml(details).replace(/\n/g, '<br>') + '</p>' +
            '<p>オプション：' + formatOptionsForEmail(optCommercial, optHidden, optCopyright) + '</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + inserted[0].id) + '">管理画面で確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { member, application: inserted[0] });
      }

      // ---- メッセージを送信する ----
      if (action === 'send-message') {
        const applicationId = Number(body.application_id);
        const text = (body.body || '').trim();
        if (!text) return jsonResponse(400, { error: 'メッセージを入力してください' });
        const appRows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId} AND member_id = ${member.id}`;
        if (appRows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });

        const inserted = await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'member', 'text', ${text}, true, false)
          RETURNING *
        `;
        notifyAdmin({
          subject: '【メッセージ】' + memberLabel(member) + ' さんからメッセージが届いています',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、メッセージが届きました。</p>' +
            '<p>' + escapeHtml(text) + '</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + applicationId) + '">管理画面で確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { message: inserted[0] });
      }

      // ---- 運営から提示されたポイント数で正式受付する ----
      if (action === 'accept-quote') {
        const applicationId = Number(body.application_id);
        const appRows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId} AND member_id = ${member.id}`;
        if (appRows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });
        const application = appRows[0];

        if (application.status !== 'ヒアリング中') {
          return jsonResponse(400, { error: 'この申請はすでに受付・対応が進んでいます' });
        }

        const quoteRows = await db.sql`
          SELECT * FROM messages
          WHERE application_id = ${applicationId} AND kind = 'quote' AND quote_status = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `;
        if (quoteRows.length === 0) return jsonResponse(400, { error: '有効なポイントのご提示が見つかりません' });
        const quote = quoteRows[0];

        // 月1プランの「今月のご依頼」は保有ポイントを使わない（基礎2pt相当はサブスクに含まれ、
        // 追加購入分（quote.point_cost=3）は正式受付時にStripeの個別請求書で別途ご案内する運用）
        let updatedMembers = [member];
        if (application.kind === 'monthly') {
          // 変更なし（point_balanceは減算しない）
        } else if (TEST_MODE_SKIP_LIMITS) {
          // テスト開発中はポイント残高チェック・消費を行わない
        } else {
          const freshMembers = await db.sql`SELECT * FROM members WHERE id = ${member.id}`;
          const freshMember = freshMembers[0];
          if (freshMember.point_balance < quote.point_cost) {
            return jsonResponse(400, { error: 'ポイントが不足しているため、この内容では正式受付できません' });
          }
          updatedMembers = await db.sql`
            UPDATE members SET point_balance = point_balance - ${quote.point_cost} WHERE id = ${member.id} RETURNING *
          `;
        }

        const updatedApp = await db.sql`
          UPDATE applications SET status = '制作中', point_cost = ${quote.point_cost}, updated_at = now()
          WHERE id = ${applicationId} RETURNING *
        `;
        await db.sql`UPDATE messages SET quote_status = 'accepted' WHERE id = ${quote.id}`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'system', 'system', ${'正式受付されました（' + quote.point_cost + 'pt）'}, true, true)
        `;
        // 正式受付の直後に、今後の制作の流れを案内する自動メッセージを送る
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'admin', 'text', ${buildProductionFlowMessage(application.kind)}, false, true)
        `;
        const threadPage = application.kind === 'monthly' ? 'message-monthly.html' : 'message.html';
        notifyMember(updatedMembers[0], {
          subject: '【正式受付】今後の制作の流れのご案内',
          html:
            '<p>ご依頼の正式受付が完了しました。今後の流れをメッセージでご案内しています。</p>' +
            '<p><a href="' + siteUrl(threadPage + '?id=' + applicationId) + '">やり取りを確認する</a></p>'
        }).catch(function () {});
        notifyAdmin({
          subject: '【正式受付】' + memberLabel(member) + ' さんが見積もりを承諾しました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんが、' + quote.point_cost + 'ptの見積もりを承諾し、正式受付（制作中）になりました。</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + applicationId) + '">管理画面で確認する</a></p>'
        }).catch(function () {});

        return jsonResponse(200, { member: updatedMembers[0], application: updatedApp[0] });
      }

      // ---- プラン変更（次回請求日から新プランが適用される想定。表示上の案内のみで、反映自体は即時） ----
      if (action === 'change-plan') {
        const newPlan = body.plan === 'monthly' ? 'monthly' : body.plan === 'point' ? 'point' : null;
        if (!newPlan) return jsonResponse(400, { error: '不正なプランです' });
        if (member.leave_requested_at) return jsonResponse(400, { error: '退会予告中はプラン変更できません。先に退会予告を取り消してください。' });
        if (newPlan === member.plan) return jsonResponse(400, { error: 'すでにこのプランをご利用中です' });

        if (!TEST_MODE_SKIP_LIMITS && newPlan === 'point') {
          const monthsSinceSignup = (Date.now() - new Date(member.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
          if (monthsSinceSignup < 3) {
            return jsonResponse(400, { error: '月1プラン→ポイントプランへの変更は、初回決済日から3ヶ月経過後に可能です' });
          }
        }
        if (!TEST_MODE_SKIP_LIMITS && newPlan === 'monthly') {
          const monthlyCountRows = await db.sql`SELECT COUNT(*)::int AS c FROM members WHERE plan = 'monthly' AND is_removed = false`;
          if (monthlyCountRows[0].c >= 2) {
            return jsonResponse(400, { error: '月1プランは現在定員に達しているため変更できません' });
          }
        }

        // Stripe側のサブスクリプションの価格（Price）も新プランのものに切り替える。
        // proration_behavior: 'none' により、今期分の請求はそのまま・次回請求日から新プランの金額が適用される。
        if (member.stripe_subscription_id) {
          try {
            const stripe = await getStripe();
            const subscription = await stripe.subscriptions.retrieve(member.stripe_subscription_id);
            const itemId = subscription.items.data[0].id;
            await stripe.subscriptions.update(member.stripe_subscription_id, {
              items: [{ id: itemId, price: priceIdForPlan(newPlan) }],
              proration_behavior: 'none'
            });
          } catch (err) {
            console.error('Stripeサブスクリプションのプラン変更に失敗しました:', err);
            return jsonResponse(500, { error: 'お支払いプランの変更に失敗しました。時間をおいて再度お試しいただくか、運営までお問い合わせください。' });
          }
        }

        const updated = await db.sql`UPDATE members SET plan = ${newPlan}, point_balance = 0 WHERE id = ${member.id} RETURNING *`;
        notifyAdmin({
          subject: '【プラン変更】' + memberLabel(member) + ' さんがプランを変更しました',
          html: '<p>' + escapeHtml(memberLabel(member)) + ' さんが、' + (PLAN_LABELS[member.plan] || member.plan) + ' から ' + (PLAN_LABELS[newPlan] || newPlan) + ' への変更を申し込みました。</p>'
        }).catch(function () {});
        return jsonResponse(200, { member: updated[0] });
      }

      // ---- 退会を申告する（当月末までの申告で翌月1日付け退会。運営の会員一覧「退会予告」に表示される） ----
      if (action === 'request-leave') {
        if (member.leave_requested_at) return jsonResponse(400, { error: 'すでに退会を申告済みです' });

        // Stripe側は即時解約ではなく「現在の請求期間の終了時に解約」を予約する
        // （全会員共通で請求日が毎月1日のため、これが「翌月1日から請求停止」の仕様に一致する）
        if (member.stripe_subscription_id) {
          try {
            const stripe = await getStripe();
            await stripe.subscriptions.update(member.stripe_subscription_id, { cancel_at_period_end: true });
          } catch (err) {
            console.error('Stripeサブスクリプションの解約予約に失敗しました:', err);
            return jsonResponse(500, { error: '退会予告の処理に失敗しました。時間をおいて再度お試しいただくか、運営までお問い合わせください。' });
          }
        }

        const updated = await db.sql`UPDATE members SET leave_requested_at = now() WHERE id = ${member.id} RETURNING *`;
        notifyAdmin({
          subject: '【退会予告】' + memberLabel(member) + ' さんが退会を申告しました',
          html: '<p>' + escapeHtml(memberLabel(member)) + ' さんが退会を申告しました。翌月1日付けで退会となります。</p>'
        }).catch(function () {});
        return jsonResponse(200, { member: updated[0] });
      }

      // ---- 退会申告を取り消す ----
      if (action === 'cancel-leave-request') {
        if (!member.leave_requested_at) return jsonResponse(400, { error: '退会の申告はありません' });

        if (member.stripe_subscription_id) {
          try {
            const stripe = await getStripe();
            await stripe.subscriptions.update(member.stripe_subscription_id, { cancel_at_period_end: false });
          } catch (err) {
            console.error('Stripeサブスクリプションの解約予約の取り消しに失敗しました:', err);
            return jsonResponse(500, { error: '退会申告の取り消しに失敗しました。時間をおいて再度お試しいただくか、運営までお問い合わせください。' });
          }
        }

        const updated = await db.sql`UPDATE members SET leave_requested_at = NULL WHERE id = ${member.id} RETURNING *`;
        return jsonResponse(200, { member: updated[0] });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }
    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
