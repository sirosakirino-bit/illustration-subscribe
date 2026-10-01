import { getDb } from './_lib/db.mjs';
import { requireUser, jsonResponse } from './_lib/auth.mjs';

// メニューから選ぶ即時受付（apply.htmlの「メニューから選ぶ」タブに対応）
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
    INSERT INTO members (
      identity_user_id, email, full_name, handle_name, zip, prefecture,
      address1, address2, usage_type, sns_x, sns_youtube, sns_twitch, plan, point_balance
    ) VALUES (
      ${user.sub}, ${user.email}, ${meta.full_name || null}, ${meta.handle_name || null},
      ${meta.zip || null}, ${meta.prefecture || null}, ${meta.address1 || null}, ${meta.address2 || null},
      ${meta.usage_type || null}, ${meta.sns_x || null}, ${meta.sns_youtube || null}, ${meta.sns_twitch || null},
      ${meta.plan || 'point'}, 0
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
      const applications = await db.sql`
        SELECT * FROM applications WHERE member_id = ${member.id} ORDER BY created_at DESC
      `;
      return jsonResponse(200, { member, applications });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      // 会員1人につき、同時に進行できる申請（ヒアリング中・制作中）は1件までとする
      // （メニュー即時受付・特殊な依頼のご相談のどちらも対象）
      if (action === 'submit-menu' || action === 'submit-consult') {
        const active = await db.sql`
          SELECT id FROM applications
          WHERE member_id = ${member.id} AND status IN ('ヒアリング中', '制作中')
        `;
        if (active.length > 0) {
          return jsonResponse(400, {
            error: '現在進行中のご依頼（ヒアリング中・制作中）が1件あるため、新しい申請はできません。対応完了後にもう一度お申し込みください。'
          });
        }
      }

      if (action === 'submit-menu') {
        const pt = Number(body.point_cost);
        if (!MENU_TITLES[pt]) {
          return jsonResponse(400, { error: '不正なメニューです' });
        }
        const notes = (body.notes || '').trim();
        if (!notes) {
          return jsonResponse(400, { error: 'ご要望メモの入力は必須です' });
        }
        if (member.point_balance < pt) {
          return jsonResponse(400, { error: 'ポイントが不足しています' });
        }

        const updatedMembers = await db.sql`
          UPDATE members SET point_balance = point_balance - ${pt} WHERE id = ${member.id} RETURNING *
        `;
        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_cost, status)
          VALUES (${member.id}, 'menu', ${MENU_TITLES[pt]}, ${notes}, ${pt}, '制作中')
          RETURNING *
        `;
        return jsonResponse(200, { member: updatedMembers[0], application: inserted[0] });
      }

      if (action === 'submit-consult') {
        const details = (body.details || '').trim();
        if (!details) {
          return jsonResponse(400, { error: 'ご依頼内容の入力は必須です' });
        }

        const inserted = await db.sql`
          INSERT INTO applications (member_id, kind, title, details, point_estimate, status)
          VALUES (
            ${member.id}, 'consult', ${body.title || '特殊な依頼のご相談'},
            ${details}, ${body.point_estimate || null}, 'ヒアリング中'
          )
          RETURNING *
        `;
        return jsonResponse(200, { member, application: inserted[0] });
      }

      return jsonResponse(400, { error: '不明な操作です' });
    }

    return jsonResponse(405, { error: 'このメソッドは使えません' });
  } catch (err) {
    return jsonResponse(err.statusCode || 500, { error: err.message || 'サーバーエラーが発生しました' });
  }
}
