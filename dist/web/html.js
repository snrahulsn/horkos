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
main { padding: 40px 24px; max-width: 1280px; margin: 0 auto; }
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
.hero { border: var(--border); display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); margin-bottom: 32px; }
.hero-copy { padding: 40px; }
.hero h1 { font-size: clamp(30px, 5vw, 62px); line-height: 1.03; text-transform: none; letter-spacing: -3px; max-width: 850px; margin: 8px 0 20px; }
.eyebrow { color: var(--red); font-weight: 700; text-transform: uppercase; letter-spacing: 2px; font-size: 11px; }
.lede { font-size: 17px; max-width: 760px; }
.hero-side { border-left: var(--border); display: grid; grid-template-rows: repeat(3, 1fr); }
.step { padding: 20px; border-bottom: 1px solid var(--fg); }
.step:last-child { border-bottom: 0; }
.step b { display: block; color: var(--red); margin-bottom: 6px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.actions a, .pager a { display: inline-block; padding: 10px 16px; border: var(--border); text-decoration: none; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; font-weight: 700; }
.actions a.primary { background: var(--fg); color: var(--bg); }
.table-wrap { overflow-x: auto; border: var(--border); }
.table-wrap table { border: 0; min-width: 760px; }
.filters { display: grid; grid-template-columns: minmax(220px, 2fr) repeat(2, minmax(140px, 1fr)) auto; gap: 8px; margin: 0 0 20px; }
input, select { font: inherit; padding: 10px; border: var(--border); background: var(--bg); color: var(--fg); min-width: 0; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 16px; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: var(--border); margin-bottom: 28px; }
.metric { padding: 22px; border-right: 1px solid var(--fg); }
.metric:last-child { border-right: 0; }
.metric .value { display: block; font-size: clamp(26px, 4vw, 44px); font-weight: 700; line-height: 1; margin-bottom: 10px; }
.metric .source { display: block; font-size: 10px; opacity: .7; margin-top: 8px; }
.dashboard-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
.trend-row { display: grid; grid-template-columns: 100px 1fr 44px; gap: 10px; align-items: center; margin: 10px 0; }
.bar-track { height: 16px; border: 1px solid var(--fg); display: flex; }
.bar-ok { background: var(--fg); }
.bar-bad { background: var(--red); }
.proof-label { display: inline-block; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; border: 1px solid var(--fg); padding: 2px 5px; }
.block p + p { margin-top: 8px; }
footer { border-top: var(--border); padding: 16px 24px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-top: 48px; }
form.confirm { margin: 16px 0; }
button.act {
  font-family: inherit; font-size: 13px; padding: 10px 24px; background: var(--fg);
  color: var(--bg); border: var(--border); cursor: pointer; text-transform: uppercase;
  letter-spacing: 1px; margin-right: 12px;
}
button.act.danger { background: var(--red); border-color: var(--red); }
textarea { width: 100%; background: var(--bg); color: var(--fg); border: var(--border); padding: 8px; font-family: inherit; margin: 8px 0; }
@media (max-width: 800px) {
  .masthead { display: block; }
  .masthead .wordmark { display: block; border-right: 0; border-bottom: var(--border); }
  .masthead nav { overflow-x: auto; }
  .masthead nav a { padding: 12px; }
  .masthead .invert { padding: 12px; }
  main { padding: 24px 14px; }
  .hero { grid-template-columns: 1fr; }
  .hero-copy { padding: 24px; }
  .hero-side { border-left: 0; border-top: var(--border); }
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .metric:nth-child(2) { border-right: 0; }
  .metric:nth-child(-n+2) { border-bottom: 1px solid var(--fg); }
  .dashboard-grid { grid-template-columns: 1fr; }
  .filters { grid-template-columns: 1fr; }
  .commitment-table { min-width: 0 !important; }
  .commitment-table th:nth-child(3), .commitment-table td:nth-child(3),
  .commitment-table th:nth-child(5), .commitment-table td:nth-child(5),
  .commitment-table th:nth-child(6), .commitment-table td:nth-child(6) { display: none; }
}
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
    const donationUrl = process.env.DONATION_URL?.startsWith('https://')
        ? process.env.DONATION_URL
        : null;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · HORKOS</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
<script>${THEME_JS}</script>
</head>
<body>
<header class="masthead">
  <a class="wordmark" href="/">HOR<span class="k">[K]</span>OS</a>
  <nav>
    <a href="/dashboard">Register</a>
    <a href="/postmortems">Failures</a>
    <a href="/stats">Stats</a>
    <a href="/oaths">Registry</a>
    <button class="invert" onclick="horkosInvert()">Theme</button>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  Verified commitments and outcomes for agent work · <a href="/log">Integrity log</a> · Free and open source${donationUrl ? ` · <a href="${esc(donationUrl)}" rel="noopener noreferrer">Donate</a>` : ''}
</footer>
</body>
</html>`;
}
export function verdictBadge(status) {
    const labels = {
        DRAFT: 'Awaiting approval', DRAFT_EXPIRED: 'Expired', OPEN: 'In progress',
        CLAIMED: 'Awaiting review', KEPT: 'Completed', BROKEN: 'Failed',
        BROKEN_UNCONFIRMED: 'Not confirmed', DISPUTED: 'Disputed',
        VOIDED: 'Cancelled', WITHDRAWN: 'Withdrawn',
    };
    const label = labels[status] ?? status;
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