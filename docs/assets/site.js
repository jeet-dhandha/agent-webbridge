// Copy buttons: [data-copy-target="<id of the element whose text is copied>"]
(function () {
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }
  function copyText(text) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function done(ok) { if (settled) return; settled = true; ok ? resolve() : reject(); }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
        setTimeout(function () { if (!settled) done(legacyCopy(text)); }, 1200);
      } else { done(legacyCopy(text)); }
    });
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-copy-target]'); if (!btn) return;
    var el = document.getElementById(btn.getAttribute('data-copy-target')); if (!el) return;
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label);
    copyText(el.innerText.trim()).then(function () {
      btn.textContent = 'Copied'; btn.classList.add('done');
      setTimeout(function () { btn.textContent = label; btn.classList.remove('done'); }, 1800);
    }, function () {
      btn.textContent = 'Select the text and copy';
      setTimeout(function () { btn.textContent = label; }, 2500);
    });
  });
})();
