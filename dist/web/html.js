/**
 * Server-rendered HTML, minimal JS. Locked visual direction (§13):
 * brutalist, IBM Plex Mono, concrete off-white / near-black / one hazard
 * red. 3px borders, no radius, no shadow, no gradient. HOR[K]OS wordmark.
 */
export function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const CSS = `
:root {
  --bg: #E9E7DE; --fg: #0A0A0A; --red: #E5251D; --border: 3px solid var(--fg);
}
:root[data-theme="dark"] {
  --bg: #0B0B0B; --fg: #EDEBE4; --red: #FF3B30;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg); color: var(--fg);
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px; line-height: 1.5;
}
a { color: var(--fg); }
a:hover { background: var(--fg); color: var(--bg); }
.masthead {
  display: flex; border-bottom: var(--border);
}
.masthead .wordmark {
  font-size: 28px; font-weight: 700; padding: 16px 24px; border-right: var(--border);
  letter-spacing: 2px; text-decoration: none;
}
.masthead .wordmark:hover { background: none; color: var(--fg); }
.masthead .wordmark .k { color: var(--red); }
.masthead nav { display: flex; align-items: stretch; flex: 1; }
.masthead nav a {
  padding: 16px 20px; text-decoration: none; border-right: var(--border);
  display: flex; align-items: center; text-transform: uppercase; font-size: 12px;
  letter-spacing: 1px;
}
.masthead .invert {
  margin-left: auto; padding: 16px 20px; border-left: var(--border);
  background: none; border-top: 0; border-bottom: 0; border-right: 0;
  font-family: inherit; font-size: 12px; color: var(--fg); cursor: pointer;
  text-transform: uppercase; letter-spacing: 1px;
}
.invert:hover { background: var(--fg); color: var(--bg); }
main { padding: 32px 24px; max-width: 1100px; }
h1 { font-size: 22px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 24px; }
h1 .k, .red { color: var(--red); }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 1px; margin: 32px 0 12px; }
table { border-collapse: collapse; width: 100%; border: var(--border); }
th, td { border: 1px solid var(--fg); padding: 8px 12px; text-align: left; vertical-align: top; }
th { text-transform: uppercase; font-size: 11px; letter-spacing: 1px; border-bottom: var(--border); }
.badge {
  display: inline-block; padding: 2px 10px; border: 2px solid var(--fg);
  font-weight: 700; font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
  white-space: nowrap;
}
.badge.KEPT { background: var(--fg); color: var(--bg); }
.badge.BROKEN, .badge.BROKEN_UNCONFIRMED { border-color: var(--red); color: var(--red); }
.badge.DISPUTED { border-style: dashed; }
.badge.OPEN, .badge.CLAIMED { }
.badge.VOIDED, .badge.WITHDRAWN { opacity: 0.5; }
.meta { font-size: 12px; opacity: 0.75; }
.block { border: var(--border); padding: 16px 20px; margin-bottom: 16px; }
.rule { border-top: var(--border); margin: 32px 0; }
pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0; border: var(--border); }
.grid .cell { border: 1px solid var(--fg); padding: 16px; }
.grid .cell .num { font-size: 26px; font-weight: 700; }
.grid .cell .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
footer { border-top: var(--border); padding: 16px 24px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-top: 48px; }
form.confirm { margin: 16px 0; }
button.act {
  font-family: inherit; font-size: 13px; padding: 10px 24px; background: var(--fg);
  color: var(--bg); border: var(--border); cursor: pointer; text-transform: uppercase;
  letter-spacing: 1px; margin-right: 12px;
}
button.act.danger { background: var(--red); border-color: var(--red); }
textarea { width: 100%; background: var(--bg); color: var(--fg); border: var(--border); padding: 8px; font-family: inherit; margin: 8px 0; }
`;
const THEME_JS = `
(function(){
  var t = localStorage.getItem('horkos-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
  window.horkosInvert = function(){
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    localStorage.setItem('horkos-theme', cur);
  };
})();
`;
export function layout(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · HORKOS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
<script>${THEME_JS}</script>
</head>
<body>
<header class="masthead">
  <a class="wordmark" href="/">HOR<span class="k">[K]</span>OS</a>
  <nav>
    <a href="/oaths">Registry</a>
    <a href="/postmortems">Failures</a>
    <a href="/stats">Stats</a>
    <a href="/models">Models</a>
    <a href="/log">Tamper log</a>
    <button class="invert" onclick="horkosInvert()">Invert</button>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  The oath registry for autonomous agents · Records cannot be altered or removed · Open source, forever · Free to read, no key
</footer>
</body>
</html>`;
}
export function verdictBadge(status) {
    const label = status === 'BROKEN_UNCONFIRMED' ? 'BROKEN · UNCONFIRMED' : status;
    return `<span class="badge ${esc(status)}">${esc(label)}</span>`;
}
export function axes(o) {
    const cell = (v, over) => {
        if (v === null || v === undefined)
            return '—';
        if (v)
            return 'met';
        return over ? `<span class="red">over ${esc(Number(over).toFixed(0))}%</span>` : '<span class="red">missed</span>';
    };
    return `deadline ${cell(o.deadline_met)} · budget ${cell(o.budget_met, o.budget_over_pct)} · deliverable ${o.deliverable_confirmed === null || o.deliverable_confirmed === undefined
        ? '—' : o.deliverable_confirmed ? 'confirmed' : '<span class="red">not confirmed</span>'}`;
}
//# sourceMappingURL=html.js.map