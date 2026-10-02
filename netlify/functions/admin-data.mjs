import { getDb } from './_lib/db.mjs';
import { requireAdmin, jsonResponse } from './_lib/auth.mjs';
import { notifyMember, escapeHtml, siteUrl } from './_lib/email.mjs';
import { computeCapacity, setCapacity } from './_lib/capacity.mjs';
import { getStripe } from './_lib/stripe.mjs';

const PLAN_LABELS = { point: 'ポイントプラン', monthly: '月1プラン' };
const PLAN_AMOUNTS = { point: 11000, monthly: 27500 }; // 税込

async function getMemberById(db, memberId) {
  const rows = await db.sql`SELECT * FROM members WHERE id = ${memberId}`;
  return rows[0] || null;
}

export async function handler(event, context) {
  const db = getDb();

  try {
    requireAdmin(context);

    if (event.httpMethod === 'GET') {
      const query = event.queryStringParameters || {};

      // ---- メッセージ管理：会員一覧（スレッド一覧） ----
      if (query.inbox) {
        const threads = await db.sql`
          SELECT a.*,
            CASE
              WHEN NULLIF(m.handle_name, '') IS NOT NULL AND NULLIF(m.full_name, '') IS NOT NULL AND m.handle_name <> m.full_name THEN m.handle_name || '（' || m.full_name || '）'
              WHEN NULLIF(m.handle_name, '') IS NOT NULL THEN m.handle_name
              WHEN NULLIF(m.full_name, '') IS NOT NULL THEN m.full_name
              ELSE m.email
            END AS member_display_name,
            m.plan AS member_plan,
            (SELECT COUNT(*) FROM messages msg WHERE msg.application_id = a.id AND msg.sender = 'member' AND msg.read_by_admin = false)::int AS unread_count,
            (SELECT msg2.body FROM messages msg2 WHERE msg2.application_id = a.id ORDER BY msg2.created_at DESC LIMIT 1) AS last_message_body,
            (SELECT msg2.created_at FROM messages msg2 WHERE msg2.application_id = a.id ORDER BY msg2.created_at DESC LIMIT 1) AS last_message_at
          FROM applications a
          JOIN members m ON m.id = a.member_id
          ORDER BY COALESCE(
            (SELECT msg3.created_at FROM messages msg3 WHERE msg3.application_id = a.id ORDER BY msg3.created_at DESC LIMIT 1),
            a.created_at
          ) DESC
        `;
        return jsonResponse(200, { threads });
      }

      // ---- お知らせ配信：保存済みテンプレート一覧 ----
      if (query.announcement_templates) {
        const templates = await db.sql`SELECT * FROM announcement_templates ORDER BY created_at DESC`;
        return jsonResponse(200, { templates });
      }

      // ---- 制作枠状況 ----
      if (query.capacity) {
        const capacity = await computeCapacity(db);
        return jsonResponse(200, { capacity });
      }

      // ---- 領収書：発行者情報 ----
      if (query.invoice_issuer) {
        const rows = await db.sql`SELECT * FROM invoice_issuer WHERE id = 1`;
        return jsonResponse(200, { issuer: rows[0] || null });
      }

      // ---- 領収書：発行履歴 ----
      if (query.receipts) {
        const receipts = await db.sql`
          SELECT receipts.*, CASE
               WHEN NULLIF(members.handle_name, '') IS NOT NULL AND NULLIF(members.full_name, '') IS NOT NULL AND members.handle_name <> members.full_name THEN members.handle_name || '（' || members.full_name || '）'
               WHEN NULLIF(members.handle_name, '') IS NOT NULL THEN members.handle_name
               WHEN NULLIF(members.full_name, '') IS NOT NULL THEN members.full_name
               ELSE members.email
             END AS member_display_name
          FROM receipts JOIN members ON members.id = receipts.member_id
          ORDER BY receipts.issued_at DESC LIMIT 100
        `;
        return jsonResponse(200, { receipts });
      }

      // ---- 領収書一括発行：対象月に発行できる会員一覧（現在アクティブな会員＝毎月1日に同額で請求される前提の近似値） ----
      if (query.invoice_candidates) {
        const members = await db.sql`
          SELECT id, email, full_name, handle_name, zip, prefecture, address1, address2, plan
          FROM members
          WHERE is_removed = false
          ORDER BY created_at ASC
        `;
        return jsonResponse(200, { members });
      }

      // ---- 決済状況（Stripe連携） ----
      if (query.payments) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const revenueRows = await db.sql`
          SELECT COALESCE(SUM(amount), 0)::int AS total, COUNT(*)::int AS c
          FROM payment_events
          WHERE event_type = 'invoice.paid' AND status = '成功' AND created_at >= ${monthStart}
        `;

        const canceledRows = await db.sql`
          SELECT COUNT(*)::int AS c FROM payment_events
          WHERE event_type = 'customer.subscription.deleted' AND created_at >= ${monthStart}
        `;

        const pastDueMembers = await db.sql`
          SELECT m.*,
            (SELECT COUNT(*)::int FROM payment_events pe WHERE pe.member_id = m.id AND pe.event_type = 'invoice.payment_failed' AND pe.created_at >= COALESCE(m.payment_failed_at, m.created_at)) AS retry_count
          FROM members m
          WHERE m.payment_status = 'past_due' AND m.is_removed = false
          ORDER BY m.payment_failed_at ASC
        `;

        const recentEvents = await db.sql`
          SELECT pe.*,
            CASE
              WHEN NULLIF(m.handle_name, '') IS NOT NULL AND NULLIF(m.full_name, '') IS NOT NULL AND m.handle_name <> m.full_name THEN m.handle_name || '（' || m.full_name || '）'
              WHEN NULLIF(m.handle_name, '') IS NOT NULL THEN m.handle_name
              WHEN NULLIF(m.full_name, '') IS NOT NULL THEN m.full_name
              ELSE m.email
            END AS member_display_name,
            m.plan AS member_plan,
            m.id AS member_id
          FROM payment_events pe
          JOIN members m ON m.id = pe.member_id
          WHERE pe.event_type IN ('invoice.paid', 'invoice.payment_failed')
          ORDER BY pe.created_at DESC
          LIMIT 50
        `;

        return jsonResponse(200, {
          revenue_total: revenueRows[0].total,
          revenue_count: revenueRows[0].c,
          canceled_count: canceledRows[0].c,
          past_due_members: pastDueMembers,
          recent_events: recentEvents,
          overdue_days: 14
        });
      }

      // ---- メッセージ管理：スレッド詳細 ----
      if (query.thread) {
        const applicationId = Number(query.thread);
        const appRows = await db.sql`
          SELECT a.*, CASE
              WHEN NULLIF(m.handle_name, '') IS NOT NULL AND NULLIF(m.full_name, '') IS NOT NULL AND m.handle_name <> m.full_name THEN m.handle_name || '（' || m.full_name || '）'
              WHEN NULLIF(m.handle_name, '') IS NOT NULL THEN m.handle_name
              WHEN NULLIF(m.full_name, '') IS NOT NULL THEN m.full_name
              ELSE m.email
            END AS member_display_name, m.plan AS member_plan
          FROM applications a JOIN members m ON m.id = a.member_id
          WHERE a.id = ${applicationId}
        `;
        if (appRows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });

        const messages = await db.sql`SELECT * FROM messages WHERE application_id = ${applicationId} ORDER BY created_at ASC`;

        await db.sql`
          UPDATE messages SET read_by_admin = true
          WHERE application_id = ${applicationId} AND sender = 'member' AND read_by_admin = false
        `;

        return jsonResponse(200, { application: appRows[0], messages });
      }

      const members = await db.sql`SELECT * FROM members ORDER BY created_at ASC`;
      const applications = await db.sql`
        SELECT applications.*, members.email AS member_email,
               CASE
               WHEN NULLIF(members.handle_name, '') IS NOT NULL AND NULLIF(members.full_name, '') IS NOT NULL AND members.handle_name <> members.full_name THEN members.handle_name || '（' || members.full_name || '）'
               WHEN NULLIF(members.handle_name, '') IS NOT NULL THEN members.handle_name
               WHEN NULLIF(members.full_name, '') IS NOT NULL THEN members.full_name
               ELSE members.email
             END AS member_display_name
        FROM applications
        JOIN members ON members.id = applications.member_id
        ORDER BY applications.created_at DESC
      `;
      const adjustments = await db.sql`
        SELECT point_adjustments.*,
               CASE
               WHEN NULLIF(members.handle_name, '') IS NOT NULL AND NULLIF(members.full_name, '') IS NOT NULL AND members.handle_name <> members.full_name THEN members.handle_name || '（' || members.full_name || '）'
               WHEN NULLIF(members.handle_name, '') IS NOT NULL THEN members.handle_name
               WHEN NULLIF(members.full_name, '') IS NOT NULL THEN members.full_name
               ELSE members.email
             END AS member_display_name
        FROM point_adjustments
        JOIN members ON members.id = point_adjustments.member_id
        ORDER BY point_adjustments.created_at DESC
      `;
      return jsonResponse(200, { members, applications, adjustments });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      if (action === 'adjust-points') {
        const memberId = Number(body.member_id);
        const delta = Number(body.delta);
        const reason = (body.reason || '').trim();
        if (!memberId || !delta || !reason) {
          return jsonResponse(400, { error: '会員・調整pt数・理由はすべて必須です' });
        }

        const updated = await db.sql`
          UPDATE members SET point_balance = point_balance + ${delta} WHERE id = ${memberId} RETURNING *
        `;
        if (updated.length === 0) {
          return jsonResponse(404, { error: '会員が見つかりません' });
        }
        await db.sql`
          INSERT INTO point_adjustments (member_id, delta, reason) VALUES (${memberId}, ${delta}, ${reason})
        `;
        return jsonResponse(200, { member: updated[0] });
      }

      if (action === 'advance-status') {
        const applicationId = Number(body.application_id);
        const newStatus = body.new_status;
        const finalPointCost = body.point_cost != null && body.point_cost !== '' ? Number(body.point_cost) : null;

        const rows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });
        const application = rows[0];

        if (newStatus === '制作中' && application.status === 'ヒアリング中') {
          if (!finalPointCost || finalPointCost < 1) {
            return jsonResponse(400, { error: '正式受付には確定ポイント数の入力が必要です' });
          }
          const memberRows = await db.sql`SELECT * FROM members WHERE id = ${application.member_id}`;
          const member = memberRows[0];
          if (!member || member.point_balance < finalPointCost) {
            return jsonResponse(400, { error: '会員のポイント残高が不足しています' });
          }
          await db.sql`UPDATE members SET point_balance = point_balance - ${finalPointCost} WHERE id = ${member.id}`;
          const updatedApp = await db.sql`
            UPDATE applications SET status = '制作中', point_cost = ${finalPointCost}, updated_at = now()
            WHERE id = ${applicationId} RETURNING *
          `;
          await db.sql`
            INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
            VALUES (${applicationId}, 'system', 'system', ${'正式受付されました（' + finalPointCost + 'pt）'}, false, true)
          `;
          notifyMember(member, {
            subject: '【正式受付のお知らせ】ご依頼が正式受付されました',
            html:
              '<p>ご依頼（' + escapeHtml(updatedApp[0].title) + '）が正式受付され、制作中になりました。</p>' +
              '<p>確定ポイント数：' + finalPointCost + 'pt</p>' +
              '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">やり取りを確認する</a></p>'
          }).catch(function () {});
          return jsonResponse(200, { application: updatedApp[0] });
        }

        if (newStatus === '対応完了' && application.status === '制作中') {
          const updatedApp = await db.sql`
            UPDATE applications SET status = '対応完了', updated_at = now()
            WHERE id = ${applicationId} RETURNING *
          `;
          await db.sql`
            INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
            VALUES (${applicationId}, 'system', 'system', '納品済みになりました（対応完了）', false, true)
          `;
          const member = await getMemberById(db, application.member_id);
          notifyMember(member, {
            subject: '【納品のお知らせ】ご依頼の制作物が完成しました',
            html:
              '<p>ご依頼（' + escapeHtml(updatedApp[0].title) + '）が納品されました。</p>' +
              '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">やり取りを確認する</a></p>'
          }).catch(function () {});
          return jsonResponse(200, { application: updatedApp[0] });
        }

        return jsonResponse(400, { error: 'そのステータス変更はできません' });
      }

      // 運営側で申請を取り消す（テスト用の申請の後片付けや、申請ミスの取り消しなど）
      // 「制作中」（＝正式受付済み・制作着手済み）になった申請は取り消し不可。「ヒアリング中」のみ取り消せる
      if (action === 'cancel-application') {
        const applicationId = Number(body.application_id);
        const rows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });
        const application = rows[0];

        if (application.status !== 'ヒアリング中') {
          return jsonResponse(400, { error: '「ヒアリング中」の申請のみ取り消せます（制作中・対応完了・取消済みの申請は取り消せません）' });
        }

        const updatedApp = await db.sql`
          UPDATE applications SET status = 'キャンセル', updated_at = now()
          WHERE id = ${applicationId} RETURNING *
        `;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'system', 'system', '運営により、この申請は取り消されました', false, true)
        `;
        const member = await getMemberById(db, application.member_id);
        notifyMember(member, {
          subject: '【お知らせ】申請が取り消されました',
          html:
            '<p>ご申請（' + escapeHtml(application.title) + '）は、運営により取り消されました。</p>' +
            '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">やり取りを確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { application: updatedApp[0] });
      }

      // ---- メッセージを送信する ----
      if (action === 'send-message') {
        const applicationId = Number(body.application_id);
        const text = (body.body || '').trim();
        if (!text) return jsonResponse(400, { error: 'メッセージを入力してください' });
        const rows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });

        const inserted = await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'admin', 'text', ${text}, false, true)
          RETURNING *
        `;
        const member = await getMemberById(db, rows[0].member_id);
        notifyMember(member, {
          subject: '【メッセージ】新しいメッセージが届いています',
          html:
            '<p>運営からメッセージが届いています。</p>' +
            '<p>' + escapeHtml(text) + '</p>' +
            '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">やり取りを確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { message: inserted[0] });
      }

      // ---- 送信済みメッセージを編集する（運営から送った通常メッセージのみ） ----
      if (action === 'edit-message') {
        const applicationId = Number(body.application_id);
        const messageId = Number(body.message_id);
        const text = (body.body || '').trim();
        if (!text) return jsonResponse(400, { error: 'メッセージを入力してください' });

        const msgRows = await db.sql`SELECT * FROM messages WHERE id = ${messageId} AND application_id = ${applicationId}`;
        if (msgRows.length === 0) return jsonResponse(404, { error: 'メッセージが見つかりません' });
        const message = msgRows[0];
        if (message.sender !== 'admin' || message.kind !== 'text') {
          return jsonResponse(400, { error: '運営から送った通常メッセージのみ編集できます' });
        }

        const updated = await db.sql`
          UPDATE messages SET body = ${text}, edited_at = now() WHERE id = ${messageId} RETURNING *
        `;
        return jsonResponse(200, { message: updated[0] });
      }

      // ---- ポイント数を提示する（会員の正式受付待ち。ステータスは変更しない） ----
      if (action === 'send-quote') {
        const applicationId = Number(body.application_id);
        const pointCost = Number(body.point_cost);
        const note = (body.note || '').trim();
        if (!pointCost || pointCost < 1) return jsonResponse(400, { error: '提示ポイント数を入力してください' });

        const rows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });
        if (rows[0].status !== 'ヒアリング中') {
          return jsonResponse(400, { error: '「ヒアリング中」の申請にのみポイントを提示できます' });
        }

        // 既存の提示中（pending）の見積もりがあれば無効化してから新しく提示する
        await db.sql`
          UPDATE messages SET quote_status = 'superseded'
          WHERE application_id = ${applicationId} AND kind = 'quote' AND quote_status = 'pending'
        `;

        const inserted = await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, point_cost, quote_status, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'admin', 'quote', ${note || null}, ${pointCost}, 'pending', false, true)
          RETURNING *
        `;
        const member = await getMemberById(db, rows[0].member_id);
        notifyMember(member, {
          subject: '【ポイントのご提示】' + pointCost + 'ptでご案内しています',
          html:
            '<p>運営からポイントのご提示があります。</p>' +
            '<p>提示ポイント数：' + pointCost + 'pt</p>' +
            (note ? '<p>' + escapeHtml(note) + '</p>' : '') +
            '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">内容を確認して正式受付する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { message: inserted[0] });
      }

      // ---- 納品する（「制作中」の申請を「対応完了」にする） ----
      if (action === 'send-delivery') {
        const applicationId = Number(body.application_id);
        const note = (body.note || '').trim();

        const rows = await db.sql`SELECT * FROM applications WHERE id = ${applicationId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '申請が見つかりません' });
        if (rows[0].status !== '制作中') {
          return jsonResponse(400, { error: '「制作中」の申請のみ納品できます' });
        }

        const updatedApp = await db.sql`
          UPDATE applications SET status = '対応完了', updated_at = now()
          WHERE id = ${applicationId} RETURNING *
        `;
        const deliveryNote = note || 'お待たせしました！ご依頼の制作物が完成しましたので、ご確認をお願いいたします。';
        const inserted = await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'admin', 'delivery', ${deliveryNote}, false, true)
          RETURNING *
        `;
        const member = await getMemberById(db, rows[0].member_id);
        notifyMember(member, {
          subject: '【納品のお知らせ】ご依頼の制作物が完成しました',
          html:
            '<p>' + escapeHtml(deliveryNote) + '</p>' +
            '<p><a href="' + siteUrl('message.html?id=' + applicationId) + '">やり取りを確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { application: updatedApp[0], message: inserted[0] });
      }

      // ---- 会員全体へのお知らせメールを送信する（運営休止のご案内など） ----
      if (action === 'broadcast-announcement') {
        const subject = (body.subject || '').trim();
        const text = (body.body || '').trim();
        if (!subject || !text) return jsonResponse(400, { error: '件名・本文はどちらも必須です' });

        const members = await db.sql`SELECT * FROM members`;
        const htmlBody = '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>';

        const results = await Promise.allSettled(
          members.map(function (m) {
            return notifyMember(m, { subject: '【お知らせ】' + subject, html: htmlBody });
          })
        );
        const sent = results.filter(function (r) { return r.status === 'fulfilled'; }).length;

        await db.sql`
          INSERT INTO announcements (subject, body, recipient_count, sent_count)
          VALUES (${subject}, ${text}, ${members.length}, ${sent})
        `;

        return jsonResponse(200, { sent: sent, total: members.length });
      }

      // ---- お知らせ配信：テンプレートを保存 ----
      if (action === 'save-announcement-template') {
        const name = (body.name || '').trim();
        const subject = (body.subject || '').trim();
        const text = (body.body || '').trim();
        if (!name || !subject || !text) return jsonResponse(400, { error: 'テンプレート名・件名・本文はすべて必須です' });

        const inserted = await db.sql`
          INSERT INTO announcement_templates (name, subject, body) VALUES (${name}, ${subject}, ${text}) RETURNING *
        `;
        return jsonResponse(200, { template: inserted[0] });
      }

      // ---- お知らせ配信：テンプレートを削除 ----
      if (action === 'delete-announcement-template') {
        const templateId = Number(body.template_id);
        if (!templateId) return jsonResponse(400, { error: 'テンプレートIDが不正です' });
        await db.sql`DELETE FROM announcement_templates WHERE id = ${templateId}`;
        return jsonResponse(200, { ok: true });
      }

      // ---- 制作枠状況：今月のポイントプラン受付可能ポイント数を更新 ----
      if (action === 'set-capacity') {
        const availablePoints = Number(body.available_points);
        if (!Number.isFinite(availablePoints) || availablePoints < 0) {
          return jsonResponse(400, { error: '受付可能ポイント数が不正です' });
        }
        const admin = requireAdmin(context);
        const capacity = await setCapacity(db, availablePoints, admin.email || null);
        return jsonResponse(200, { capacity });
      }

      // ---- 強制退会（即時利用停止）。通常の退会（翌月1日付け）とは異なり確定時点で即時アクセス不可・ポイント失効 ----
      if (action === 'force-remove-member') {
        const memberId = Number(body.member_id);
        const reason = (body.reason || '').trim();
        if (!memberId || !reason) return jsonResponse(400, { error: '会員・理由はどちらも必須です' });

        const beforeRows = await db.sql`SELECT * FROM members WHERE id = ${memberId}`;
        if (beforeRows.length === 0) return jsonResponse(404, { error: '会員が見つかりません' });
        const targetBefore = beforeRows[0];

        const rows = await db.sql`
          UPDATE members SET is_removed = true, removed_reason = ${reason}, removed_at = now(), point_balance = 0
          WHERE id = ${memberId} RETURNING *
        `;

        // Stripe側のサブスクリプションも即時キャンセルし、以降の請求が発生しないようにする
        if (targetBefore.stripe_subscription_id) {
          try {
            const stripe = getStripe();
            await stripe.subscriptions.cancel(targetBefore.stripe_subscription_id);
          } catch (err) {
            console.error('強制退会に伴うStripeサブスクリプションのキャンセルに失敗しました:', err);
          }
        }

        // 進行中の申請はすべて取り消し扱いにする
        await db.sql`
          UPDATE applications SET status = 'キャンセル', updated_at = now()
          WHERE member_id = ${memberId} AND status IN ('ヒアリング中', '制作中')
        `;

        return jsonResponse(200, { member: rows[0] });
      }

      // ---- サブスクリプションの休止／再開（Stripeのpause collection機能を使用。契約は維持したまま課金のみ止める） ----
      if (action === 'pause-member' || action === 'resume-member') {
        const memberId = Number(body.member_id);
        if (!memberId) return jsonResponse(400, { error: '会員の指定が必要です' });

        const rows = await db.sql`SELECT * FROM members WHERE id = ${memberId}`;
        if (rows.length === 0) return jsonResponse(404, { error: '会員が見つかりません' });
        const target = rows[0];
        if (!target.stripe_subscription_id) {
          return jsonResponse(400, { error: 'この会員はまだStripeのサブスクリプションと紐付いていません' });
        }

        const stripe = getStripe();
        try {
          if (action === 'pause-member') {
            await stripe.subscriptions.update(target.stripe_subscription_id, { pause_collection: { behavior: 'void' } });
          } else {
            await stripe.subscriptions.update(target.stripe_subscription_id, { pause_collection: '' });
          }
        } catch (err) {
          console.error('サブスクリプションの休止/再開に失敗しました:', err);
          return jsonResponse(500, { error: '処理に失敗しました：' + err.message });
        }

        // 実際のpayment_statusの更新は、Stripeから届くcustomer.subscription.updated Webhookで行われる。
        // ここでは画面側の即時反映用に、わかっている範囲で先に反映しておく。
        const updated = await db.sql`
          UPDATE members SET payment_status = ${action === 'pause-member' ? 'paused' : 'active'} WHERE id = ${memberId} RETURNING *
        `;
        return jsonResponse(200, { member: updated[0] });
      }

      // ---- 領収書：発行者情報（フルネーム・電話番号・住所・角印画像）を保存 ----
      if (action === 'save-invoice-issuer') {
        const fullName = (body.full_name || '').trim();
        const phone = (body.phone || '').trim();
        const zip = (body.zip || '').trim();
        const address = (body.address || '').trim();
        const stampImageDataUrl = body.stamp_image_data_url || null;

        const existing = await db.sql`SELECT stamp_image_data_url FROM invoice_issuer WHERE id = 1`;
        const keepStamp = stampImageDataUrl === undefined || stampImageDataUrl === null
          ? (existing[0] ? existing[0].stamp_image_data_url : null)
          : stampImageDataUrl;

        const upserted = await db.sql`
          INSERT INTO invoice_issuer (id, full_name, phone, zip, address, stamp_image_data_url, updated_at)
          VALUES (1, ${fullName}, ${phone}, ${zip}, ${address}, ${keepStamp}, now())
          ON CONFLICT (id) DO UPDATE SET
            full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, zip = EXCLUDED.zip,
            address = EXCLUDED.address, stamp_image_data_url = EXCLUDED.stamp_image_data_url, updated_at = now()
          RETURNING *
        `;
        return jsonResponse(200, { issuer: upserted[0] });
      }

      // ---- 領収書：発行記録を1件保存する（PDF自体はブラウザ側で生成。ここでは発行履歴として記録のみ） ----
      if (action === 'issue-receipt') {
        const memberId = Number(body.member_id);
        const periodMonth = (body.period_month || '').trim();
        if (!memberId || !periodMonth) return jsonResponse(400, { error: '会員・対象月はどちらも必須です' });

        const memberRows = await db.sql`SELECT * FROM members WHERE id = ${memberId}`;
        if (memberRows.length === 0) return jsonResponse(404, { error: '会員が見つかりません' });
        const targetMember = memberRows[0];
        const amount = PLAN_AMOUNTS[targetMember.plan] || 0;

        const inserted = await db.sql`
          INSERT INTO receipts (member_id, period_month, plan, amount_total)
          VALUES (${memberId}, ${periodMonth}, ${targetMember.plan}, ${amount})
          RETURNING *
        `;
        return jsonResponse(200, { receipt: inserted[0], member: targetMember });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }

    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
