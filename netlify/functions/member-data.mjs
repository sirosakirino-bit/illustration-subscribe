import { getDb } from './_lib/db.mjs';
import { requireUser, jsonResponse } from './_lib/auth.mjs';
import { notifyAdmin, escapeHtml, siteUrl } from './_lib/email.mjs';

function memberLabel(member) {
  return member.handle_name || member.full_name || member.email;
}

const MENU_TITLES = {
  1: 'ミニキャラ／SNSアイコン等（1pt・メニュー選択）',
  2: 'バストアップ＋簡易背景（2pt・メニュー選択）',
  3: '腰上＋背景／人物2人まで（3pt・メニュー選択）'
};

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
  const db = getDb();
  try {
    const user = requireUser(context);
    const member = await ensureMember(db, user);

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
      return jsonResponse(200, { member, applications });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      // 会員1人につき、同時に進行できる申請（ヒアリング中・制作中）は1件までとする
      if (action === 'submit-menu' || action === 'submit-consult') {
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
        if (member.point_balance < pt) return jsonResponse(400, { error: 'ポイントが不足しています' });
        const updatedMembers = await db.sql`UPDATE members SET point_balance = point_balance - ${pt} WHERE id = ${member.id} RETURNING *`;
        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_cost, status)
          VALUES (${member.id}, 'menu', ${MENU_TITLES[pt]}, ${notes}, ${pt}, '制作中') RETURNING *`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${inserted[0].id}, 'member', 'text', ${notes}, true, false)
        `;
        notifyAdmin({
          subject: '【新しい申請】' + memberLabel(member) + ' さんから制作メニューの申請がありました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、新しい申請がありました。</p>' +
            '<p>内容：' + escapeHtml(inserted[0].title) + '</p>' +
            '<p>ご要望メモ：' + escapeHtml(notes) + '</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + inserted[0].id) + '">管理画面で確認する</a></p>'
        }).catch(function () {});
        return jsonResponse(200, { member: updatedMembers[0], application: inserted[0] });
      }

      if (action === 'submit-consult') {
        const details = (body.details || '').trim();
        if (!details) return jsonResponse(400, { error: 'ご依頼内容の入力は必須です' });
        const pending = await db.sql`
          SELECT id FROM applications WHERE member_id = ${member.id} AND kind = 'consult' AND status = 'ヒアリング中'`;
        if (pending.length > 0) return jsonResponse(400, { error: 'すでに相談中（ヒアリング中）の申請があります。回答・正式受付が済んでから、次のご相談をお送りください。' });
        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_estimate, status)
          VALUES (${member.id}, 'consult', ${body.title || '特殊な依頼のご相談'}, ${details}, ${body.point_estimate || null}, 'ヒアリング中') RETURNING *`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${inserted[0].id}, 'member', 'text', ${details}, true, false)
        `;
        notifyAdmin({
          subject: '【新しい申請】' + memberLabel(member) + ' さんから特殊な依頼のご相談がありました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんから、特殊な依頼のご相談がありました。</p>' +
            '<p>内容：' + escapeHtml(details) + '</p>' +
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

        const freshMembers = await db.sql`SELECT * FROM members WHERE id = ${member.id}`;
        const freshMember = freshMembers[0];
        if (freshMember.point_balance < quote.point_cost) {
          return jsonResponse(400, { error: 'ポイントが不足しているため、この内容では正式受付できません' });
        }

        const updatedMembers = await db.sql`
          UPDATE members SET point_balance = point_balance - ${quote.point_cost} WHERE id = ${member.id} RETURNING *
        `;
        const updatedApp = await db.sql`
          UPDATE applications SET status = '制作中', point_cost = ${quote.point_cost}, updated_at = now()
          WHERE id = ${applicationId} RETURNING *
        `;
        await db.sql`UPDATE messages SET quote_status = 'accepted' WHERE id = ${quote.id}`;
        await db.sql`
          INSERT INTO messages (application_id, sender, kind, body, read_by_member, read_by_admin)
          VALUES (${applicationId}, 'system', 'system', ${'正式受付されました（' + quote.point_cost + 'pt）'}, true, true)
        `;
        notifyAdmin({
          subject: '【正式受付】' + memberLabel(member) + ' さんが見積もりを承諾しました',
          html:
            '<p>' + escapeHtml(memberLabel(member)) + ' さんが、' + quote.point_cost + 'ptの見積もりを承諾し、正式受付（制作中）になりました。</p>' +
            '<p><a href="' + siteUrl('admin-inbox.html#' + applicationId) + '">管理画面で確認する</a></p>'
        }).catch(function () {});

        return jsonResponse(200, { member: updatedMembers[0], application: updatedApp[0] });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }
    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
