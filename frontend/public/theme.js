// Applies the stored or system theme before first paint (external file: the CSP forbids inline scripts).
(function () { try { var t = localStorage.getItem('move-openlab-theme'); if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', t); } catch (e) { /* ignore */ } })();
