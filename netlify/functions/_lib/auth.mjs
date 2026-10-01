// 会員ログイン（Netlify Identity）まわりの共通処理

export function getUser(context) {
  return (context && context.clientContext && context.clientContext.user) || null;
}

export function requireUser(context) {
  const user = getUser(context);
  if (!user) {
    const err = new Error('ログインが必要です');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

export function requireAdmin(context) {
  const user = requireUser(context);
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  if (!roles.includes('admin')) {
    const err = new Error('管理者権限が必要です');
    err.statusCode = 403;
    throw err;
  }
  return user;
}

export function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}
