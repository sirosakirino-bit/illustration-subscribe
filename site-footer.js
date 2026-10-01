/*
  [サイト名] 全ページ共通の帯（コピーライト表記＋利用規約リンク）
  どのページにも <script src="site-footer.js"></script> を1行追加するだけで、
  画面の一番上に自動で表示されます。
*/
(function () {
  function inject() {
    if (document.getElementById('site-top-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'site-top-bar';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 20px;background:#eef8fd;border-bottom:1px solid #dcedf5;font-size:10.5px;color:#8fa2ac;font-family:"M PLUS Rounded 1c",system-ui,sans-serif;position:relative;z-index:1000;';
    bar.innerHTML =
      '<span>&copy; KurageIka</span>' +
      '<a href="signup-terms.html" style="color:#2f9bd6;text-decoration:none;font-weight:700;">利用規約・制度について</a>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
