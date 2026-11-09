// Applies the user's chosen appearance before first paint (external file: the CSP forbids inline scripts).
// Light is the default for everyone, whatever the operating-system setting; dark only when the user chose it.
(function () { try { var t = localStorage.getItem('move-openlab-theme'); document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light'); } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); } })();
