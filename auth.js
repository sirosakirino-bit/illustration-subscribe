/*
  [サイト名] 会員ログイン共通処理（Netlify Identity）
  このファイルは全ページで共通して読み込みます。
  各ページ側は <script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>
  の直後にこのファイルを読み込んでください。

  使い方（HTML側に付ける目印）：
  - <body data-require-auth> … 未ログインなら自動で login.html に飛ばす（会員専用ページ）
  - <body data-guest-only>   … すでにログイン済みなら自動で mypage.html に飛ばす（ログイン画面など）
  - data-user-name           … ログイン中の会員の名前を自動で差し込む要素
  - data-user-initial        … 名前の頭文字（アイコン用）を自動で差し込む要素
  - data-user-email          … ログイン中のメールアドレスを自動で差し込む要素
  - data-action="logout"     … クリックでログアウトするボタン/リンク
  - data-action="open-login" … クリックでログイン用ポップアップを開くボタン/リンク
  - data-auth-error          … エラーメッセージを表示する場所（任意）
*/
(function () {
  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function displayNameOf(user) {
    if (!user) return '';
    var meta = user.user_metadata || {};
    return meta.full_name || meta.handle_name || user.email || '';
  }

  function fillUserDisplay(user) {
    var name = displayNameOf(user);
    document.querySelectorAll('[data-user-name]').forEach(function (el) {
      el.textContent = name;
    });
    document.querySelectorAll('[data-user-initial]').forEach(function (el) {
      el.textContent = name ? name.charAt(0) : '?';
    });
    document.querySelectorAll('[data-user-email]').forEach(function (el) {
      el.textContent = (user && user.email) || '';
    });
  }

  // 新規登録フォームで入力した「本名・住所・ハンドルネームなど」は
  // Identityのポップアップでは入力できないため、一時的にブラウザに保存しておき、
  // ログインが成立したタイミングでまとめて会員情報（user_metadata）に書き込みます。
  function applyPendingProfile(user) {
    if (!user) return;
    try {
      var raw = localStorage.getItem('pendingProfile');
      if (!raw) return;
      localStorage.removeItem('pendingProfile');
      var data = JSON.parse(raw);
      user.update({ data: data }).catch(function (err) {
        console.error('プロフィール情報の保存に失敗しました', err);
      });
    } catch (e) {
      /* 保存に失敗しても致命的ではないため、ここでは無視します */
    }
  }

  whenReady(function () {
    if (!window.netlifyIdentity) {
      console.error('Netlify Identityの読み込みに失敗しました。インターネット接続を確認してください。');
      return;
    }

    netlifyIdentity.init();

    netlifyIdentity.on('init', function (user) {
      if (user) {
        fillUserDisplay(user);
      }

      if (document.body.hasAttribute('data-require-auth') && !user) {
        location.href = 'login.html';
        return;
      }
      if (document.body.hasAttribute('data-guest-only') && user) {
        location.href = 'mypage.html';
      }
    });

    netlifyIdentity.on('login', function (user) {
      applyPendingProfile(user);
      fillUserDisplay(user);
      netlifyIdentity.close();
      location.href = 'mypage.html';
    });

    netlifyIdentity.on('logout', function () {
      location.href = 'login.html';
    });

    netlifyIdentity.on('error', function (err) {
      console.error('Netlify Identityエラー:', err);
      var box = document.querySelector('[data-auth-error]');
      if (box) {
        box.textContent = 'エラーが発生しました：' + (err && err.message ? err.message : err);
        box.style.display = 'block';
      }
    });

    document.querySelectorAll('[data-action="logout"]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        netlifyIdentity.logout();
      });
    });

    document.querySelectorAll('[data-action="open-login"]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        netlifyIdentity.open('login');
      });
    });
  });

  // ログイン中のユーザーのJWTを付けて、Netlify Functions（サーバー側の処理）を呼び出す共通関数
  function callFunction(name, options) {
    options = options || {};
    var user = window.netlifyIdentity && netlifyIdentity.currentUser();
    var headersPromise = user
      ? user.jwt().then(function (token) {
          return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
        })
      : Promise.resolve({ 'Content-Type': 'application/json' });

    var url = '/.netlify/functions/' + name;
    if (options.query) {
      var params = Object.keys(options.query)
        .filter(function (k) { return options.query[k] !== undefined && options.query[k] !== null && options.query[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(options.query[k]); });
      if (params.length) url += '?' + params.join('&');
    }

    return headersPromise.then(function (headers) {
      return fetch(url, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body ? JSON.stringify(options.body) : undefined
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || ('エラーが発生しました（status ' + res.status + '）'));
            err.statusCode = res.status;
            throw err;
          }
          return data;
        });
      });
    });
  }

  // signup-account.html から呼び出して使う補助関数
  window.AuthHelpers = {
    beginSignup: function (email, fullName, extraProfileData) {
      try {
        localStorage.setItem('pendingProfile', JSON.stringify(extraProfileData || {}));
      } catch (e) {
        /* 保存に失敗しても登録自体は続行します */
      }
      netlifyIdentity.open('signup', { email: email, full_name: fullName });
    },
    callFunction: callFunction
  };
})();
