import { getDb } from './_lib/db.mjs';
import { requireAdmin, jsonResponse } from './_lib/auth.mjs';
import { notifyMember, escapeHtml, siteUrl } from './_lib/email.mjs';

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
            COALESCE(m.handle_name, m.full_name, m.email) AS member_display_name,
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

      // ---- メッセージ管理：スレッド詳細 ----
      if (query.thread) {
        const applicationId = Number(query.thread);
        const appRows = await db.sql`
          SELECT a.*, COALESCE(m.handle_name, m.full_name, m.email) AS member_display_name, m.plan AS member_plan
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
               COALESCE(members.handle_name, members.full_name, members.email) AS member_display_name
        FROM applications
        JOIN members ON members.id = applications.member_id
        ORDER BY applications.created_at DESC
      `;
      const adjustments = await db.sql`
        SELECT point_adjustments.*,
               COALESCE(members.handle_name, members.full_name, members.email) AS member_display_name
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

        return jsonResponse(200, { sent: sent, total: members.length });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }

    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
