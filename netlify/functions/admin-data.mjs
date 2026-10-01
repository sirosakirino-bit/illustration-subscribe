import { getDatabase } from '@netlify/database';
import { requireAdmin, jsonResponse } from './_lib/auth.mjs';

export async function handler(event, context) {
  const db = getDatabase();

  try {
    requireAdmin(context);

    if (event.httpMethod === 'GET') {
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
          return jsonResponse(200, { application: updatedApp[0] });
        }

        if (newStatus === '対応完了' && application.status === '制作中') {
          const updatedApp = await db.sql`
            UPDATE applications SET status = '対応完了', updated_at = now()
            WHERE id = ${applicationId} RETURNING *
          `;
          return jsonResponse(200, { application: updatedApp[0] });
        }

        return jsonResponse(400, { error: 'そのステータス変更はできません' });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }

    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
