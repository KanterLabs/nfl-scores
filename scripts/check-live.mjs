// Parse the live ESPN scoreboard with games.js and print what the popup shows.
// Run: node scripts/check-live.mjs
import {parseScoreboard} from '../games.js';

const response = await fetch('https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
if (!response.ok)
    throw new Error(`HTTP ${response.status}`);

const {week, seasonType, games} = parseScoreboard(await response.json());
console.log(`Week ${week} · ${seasonType} · ${games.length} games\n`);

for (const g of games) {
    const side = t => `${t.possession ? '•' : ' '} ${t.abbr.padEnd(3)} ${t.name.padEnd(12)} ${t.record.padEnd(5)} ${g.state === 'pre' ? '' : t.score}`;
    const status = [g.detail, g.downDistance, g.redZone ? 'RED ZONE' : null,
        g.state === 'pre' ? g.broadcast : null].filter(Boolean).join(' · ');
    console.log(`[${g.state}] ${status}\n  ${side(g.away)}\n  ${side(g.home)}`);
}

// Detail view: parse one live (or else first) game's summary.
import {parseSummary, summaryUrl} from '../games.js';
const pick = games.find(g => g.state === 'in') ?? games[0];
if (pick) {
    const detail = await fetch(summaryUrl(pick.id));
    if (!detail.ok)
        throw new Error(`summary HTTP ${detail.status}`);
    const s = parseSummary(await detail.json());
    console.log(`\n=== ${pick.away.abbr} @ ${pick.home.abbr} detail`);
    console.log('linescores', s.linescores);
    console.log('probability', s.probability, 'odds', s.odds);
    console.log('drive', s.drive);
    console.log('where', s.where, 'lastFive', s.lastFive);
    for (const r of s.stats) console.log(`  ${r.away.padStart(6)}  ${r.label.padEnd(12)} ${r.home}`);
    for (const l of s.leaders) console.log(`  ${l.label}: ${l.away?.name} ${l.away?.line} | ${l.home?.name} ${l.home?.line}`);
    for (const p of s.scoring) console.log(`  Q${p.period} ${p.clock} ${p.type} ${p.away}-${p.home} ${p.text}`);
}

// Gamecast: text drive chart for the same game. Pass a fixture path to check
// offline: node scripts/check-live.mjs fixtures/summary-...json
import {parseGamecast, kindLabel} from '../games.js';
import {readFileSync} from 'node:fs';
const fixture = process.argv[2];
const raw = fixture ? JSON.parse(readFileSync(fixture)) : pick
    ? await (await fetch(summaryUrl(pick.id))).json() : null;
if (raw) {
    const g = parseGamecast(raw);
    console.log(`\n=== gamecast: ${g.drives.length} drives, ${g.winProbability.length} win-prob points`);
    const col = yl => Math.round((100 - yl) / 2.5); // away goal left, home goal right
    for (const d of g.drives) {
        const line = Array(41).fill('·');
        if (d.startYL != null && d.endYL != null) {
            const [a, b] = [col(d.startYL), col(d.endYL)].sort((x, y) => x - y);
            for (let i = a; i <= b; i++) line[i] = '━';
        }
        const team = d.teamId === g.homeId ? 'HOME' : 'AWAY';
        console.log(`${team} |${line.join('')}| ${d.resultShort ?? (d.current ? 'NOW' : '')} ${d.description}`);
    }
    const last = g.drives.at(-1);
    console.log('\nlast drive plays:');
    for (const p of last?.plays.slice(-5) ?? [])
        console.log(`  ${(p.downDistance ?? '').padEnd(10)} ${kindLabel(p.kind).padEnd(10)} ${String(p.yards ?? '').padStart(4)}  ${p.startYL}→${p.endYL}  ${p.text.slice(0, 70)}`);
}
