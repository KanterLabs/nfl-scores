// Pure ESPN scoreboard parsing. No GNOME imports, so it runs under node for
// tests (see scripts/check-live.mjs).

const SEASON_TYPES = {1: 'Preseason', 2: 'Regular season', 3: 'Postseason', 4: 'Off-season'};

function parseTeam(competitor, situation) {
    const team = competitor.team ?? {};
    const id = team.id ?? competitor.id;
    return {
        id,
        abbr: team.abbreviation ?? '?',
        name: team.shortDisplayName ?? team.displayName ?? team.abbreviation ?? '',
        color: /^[0-9a-f]{6}$/i.test(team.color ?? '') ? team.color : '5a6878',
        alternateColor: /^[0-9a-f]{6}$/i.test(team.alternateColor ?? '') ? team.alternateColor : null,
        record: competitor.records?.[0]?.summary ?? '',
        score: competitor.score ?? '',
        winner: competitor.winner === true,
        possession: situation.possession != null && String(situation.possession) === String(id),
    };
}

// Rough perceptual distance between two hex colors.
function colorDistance(a, b) {
    const rgb = hex => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    const [r1, g1, b1] = rgb(a);
    const [r2, g2, b2] = rgb(b);
    const rMean = (r1 + r2) / 2;
    return Math.sqrt((2 + rMean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rMean) / 256) * (b1 - b2) ** 2);
}

// Two red teams would make split bars and end zones one color: swap in an
// alternate color (away team's first, then the home team's) when the
// primaries are too close. White alternates vanish on the light turf.
const COLOR_CLASH = 130;

function separateColors(away, home) {
    if (colorDistance(away.color, home.color) >= COLOR_CLASH)
        return;
    const usable = hex => hex && colorDistance(hex, 'ffffff') > 90;
    if (usable(away.alternateColor) && colorDistance(away.alternateColor, home.color) >= COLOR_CLASH)
        away.color = away.alternateColor;
    else if (usable(home.alternateColor) && colorDistance(home.alternateColor, away.color) >= COLOR_CLASH)
        home.color = home.alternateColor;
}

export function parseGame(event) {
    const comp = event.competitions?.[0] ?? {};
    const status = event.status ?? {};
    const type = status.type ?? {};
    const situation = comp.situation ?? {};
    const competitors = comp.competitors ?? [];
    const find = side => competitors.find(c => c.homeAway === side);
    const away = find('away') ?? competitors[0] ?? {};
    const home = find('home') ?? competitors[1] ?? {};

    const state = ['pre', 'in', 'post'].includes(type.state) ? type.state : 'pre';
    // ESPN keeps the last play's field position through halftime and quarter
    // breaks, so down, distance and red zone only apply while the clock runs.
    const inPlay = state === 'in' && type.name === 'STATUS_IN_PROGRESS';
    let clock = null;
    if (inPlay && status.period) {
        const period = status.period > 4 ? 'OT' : `Q${status.period}`;
        clock = `${period} ${status.displayClock ?? ''}`.trim();
    }

    const awayTeam = parseTeam(away, inPlay ? situation : {});
    const homeTeam = parseTeam(home, inPlay ? situation : {});
    separateColors(awayTeam, homeTeam);

    return {
        id: String(event.id),
        state,
        scheduled: state === 'pre' && type.name === 'STATUS_SCHEDULED',
        detail: clock ?? type.shortDetail ?? type.description ?? '',
        kickoff: Date.parse(event.date ?? '') || null,
        downDistance: inPlay ? situation.downDistanceText ?? null : null,
        redZone: inPlay && situation.isRedZone === true,
        // Field position for the gamecast. yardLine counts from the home
        // team's goal line (0) to the away team's (100).
        spot: inPlay && Number.isFinite(situation.yardLine) ? {
            yardLine: situation.yardLine,
            down: situation.down ?? null,
            distance: situation.distance ?? null,
            possession: situation.possession != null ? String(situation.possession) : null,
        } : null,
        timeouts: state === 'in' ? {
            away: situation.awayTimeouts ?? null,
            home: situation.homeTimeouts ?? null,
        } : null,
        broadcast: (comp.broadcasts ?? []).flatMap(b => b.names ?? [])[0] ?? null,
        link: (event.links ?? []).find(l => l.rel?.includes('summary'))?.href ??
            event.links?.[0]?.href ?? null,
        away: awayTeam,
        home: homeTeam,
    };
}

// Live first, then upcoming by kickoff, then finals.
const STATE_ORDER = {in: 0, pre: 1, post: 2};

export function parseScoreboard(data) {
    const games = (data.events ?? [])
        .map(parseGame)
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
            (a.kickoff ?? 0) - (b.kickoff ?? 0));

    return {
        week: data.week?.number ?? null,
        seasonType: SEASON_TYPES[data.season?.type] ?? null,
        games,
    };
}

export function logoUrl(abbr) {
    const slug = encodeURIComponent(abbr.toLowerCase());
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=96&w=96`;
}

// Per-game detail from ESPN's summary endpoint. Clock, possession and down
// come from the scoreboard game; this adds everything the scoreboard lacks.

export function summaryUrl(gameId) {
    return `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(gameId)}`;
}

const STAT_ROWS = [
    ['totalYards', 'Total yards'],
    ['netPassingYards', 'Passing'],
    ['rushingYards', 'Rushing'],
    ['firstDowns', 'First downs'],
    ['thirdDownEff', '3rd down'],
    ['redZoneAttempts', 'Red zone'],
    ['turnovers', 'Turnovers'],
    ['totalPenaltiesYards', 'Penalties'],
    ['possessionTime', 'Possession'],
];

const LEADER_CATEGORIES = [
    ['passingYards', 'Passing'],
    ['rushingYards', 'Rushing'],
    ['receivingYards', 'Receiving'],
];

// "249" -> 249, "6-11" -> 6, "23:57" -> 1437. Used only to size stat bars.
function statMagnitude(text) {
    const clock = /^(\d+):(\d{2})$/.exec(text);
    if (clock)
        return Number(clock[1]) * 60 + Number(clock[2]);
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : 0;
}

function isNoise(play) {
    return /timeout/i.test(play.type?.text ?? '') || /timeout at/i.test(play.text ?? '');
}

export function parseSummary(data) {
    const comp = data.header?.competitions?.[0] ?? {};
    const byId = new Map();
    for (const c of comp.competitors ?? []) {
        const id = String(c.team?.id ?? c.id);
        byId.set(id, {
            id,
            side: c.homeAway,
            linescores: (c.linescores ?? []).map(l => l.displayValue ?? String(l.value ?? '')),
        });
    }
    const idFor = side => [...byId.values()].find(t => t.side === side)?.id ?? null;
    const awayId = idFor('away');
    const homeId = idFor('home');

    const statsFor = id => (data.boxscore?.teams ?? [])
        .find(t => String(t.team?.id) === id)?.statistics ?? [];
    const awayStats = statsFor(awayId);
    const homeStats = statsFor(homeId);
    const stats = [];
    for (const [name, label] of STAT_ROWS) {
        const away = awayStats.find(s => s.name === name)?.displayValue;
        const home = homeStats.find(s => s.name === name)?.displayValue;
        if (away === undefined || home === undefined)
            continue;
        stats.push({label, away, home, awayValue: statMagnitude(away), homeValue: statMagnitude(home)});
    }

    const leaderFor = (id, category) => {
        const group = (data.leaders ?? []).find(l => String(l.team?.id) === id);
        const top = group?.leaders?.find(c => c.name === category)?.leaders?.[0];
        return top ? {name: top.athlete?.shortName ?? top.athlete?.displayName ?? '', line: top.displayValue ?? ''} : null;
    };
    const leaders = LEADER_CATEGORIES
        .map(([category, label]) => ({label, away: leaderFor(awayId, category), home: leaderFor(homeId, category)}))
        .filter(row => row.away || row.home);

    const scoring = (data.scoringPlays ?? []).map(p => ({
        period: p.period?.number ?? null,
        clock: p.clock?.displayValue ?? '',
        teamId: String(p.team?.id ?? ''),
        type: p.type?.abbreviation ?? '',
        text: p.text ?? '',
        away: p.awayScore ?? '',
        home: p.homeScore ?? '',
    }));

    let drive = null;
    const current = data.drives?.current;
    if (current) {
        const lastPlay = [...(current.plays ?? [])].reverse().find(p => !isNoise(p));
        drive = {
            teamId: String(current.team?.id ?? ''),
            description: current.description ?? '',
            lastPlay: lastPlay?.text ?? null,
        };
    }

    // Live: ESPN's win probability after the latest play. Before kickoff: its
    // matchup projection. Finals get neither.
    const state = comp.status?.type?.state;
    let probability = null;
    const lastProb = data.winprobability?.at?.(-1);
    if (state === 'in' && lastProb?.homeWinPercentage != null) {
        probability = {label: 'Win probability', home: lastProb.homeWinPercentage * 100};
    } else if (state === 'pre' && data.predictor?.homeTeam?.gameProjection != null) {
        probability = {label: 'ESPN matchup projection', home: parseFloat(data.predictor.homeTeam.gameProjection)};
    }
    if (probability && !Number.isFinite(probability.home))
        probability = null;

    const pick = data.pickcenter?.[0];
    const odds = state === 'pre' && pick
        ? [pick.details, pick.overUnder != null ? `O/U ${pick.overUnder}` : null].filter(Boolean).join('  ·  ') || null
        : null;

    const lastFive = {};
    for (const entry of data.lastFiveGames ?? [])
        lastFive[String(entry.team?.id)] = (entry.events ?? []).map(e => e.gameResult).filter(Boolean);

    const venue = data.gameInfo?.venue;
    const address = venue?.address ?? {};
    const temperature = data.gameInfo?.weather?.temperature;
    const where = [
        venue?.fullName,
        [address.city, address.state].filter(Boolean).join(', ') || null,
        temperature != null ? `${temperature}°F` : null,
    ].filter(Boolean).join('  ·  ') || null;

    return {
        awayId,
        homeId,
        linescores: {away: byId.get(awayId)?.linescores ?? [], home: byId.get(homeId)?.linescores ?? []},
        stats,
        leaders,
        leadersAreSeason: state === 'pre',
        scoring,
        drive,
        probability,
        odds,
        lastFive: {away: lastFive[awayId] ?? [], home: lastFive[homeId] ?? []},
        where,
    };
}

// ----- Gamecast: drives and plays -----
// Every yardLine counts from the home goal line (0) to the away goal line
// (100), verified against ESPN's "at XXX nn" text on every play.

const HIDDEN_PLAY = /timeout|end period|end of (half|game|quarter)|two-minute warning|coin toss/i;

export function playKind(play) {
    const type = (play.type?.text ?? '').toLowerCase();
    const text = play.text ?? '';
    if (play.scoringPlay && /touchdown/.test(type + text.toLowerCase()))
        return 'touchdown';
    if (/interception|fumble recovery \(opponent\)|muffed/.test(type) || /INTERCEPTED/.test(text))
        return 'turnover';
    if (/field goal|extra point|two-point/.test(type))
        return play.scoringPlay ? 'score' : 'kick';
    if (/safety/.test(type))
        return 'score';
    if (/sack/.test(type))
        return 'sack';
    if (/penalty/.test(type))
        return 'penalty';
    if (/punt|kickoff/.test(type))
        return 'kick';
    if (/pass/.test(type))
        return 'pass';
    if (/rush/.test(type))
        return 'rush';
    return 'other';
}

const KIND_LABELS = {
    touchdown: 'TOUCHDOWN', turnover: 'TURNOVER', score: 'SCORE', kick: 'KICK',
    sack: 'SACK', penalty: 'PENALTY', pass: 'PASS', rush: 'RUSH', other: 'PLAY',
};

export function kindLabel(kind) {
    return KIND_LABELS[kind] ?? 'PLAY';
}

function tidyPlayText(text) {
    return (text ?? '')
        .replace(/^\s*\((?:Shotgun|No Huddle(?:, Shotgun)?|Pistol|Punt formation|Field Goal formation)\)\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parsePlay(play, fallbackTeamId) {
    const finite = n => (Number.isFinite(n) ? n : null);
    return {
        id: String(play.id ?? ''),
        teamId: String(play.start?.team?.id ?? fallbackTeamId ?? ''),
        period: play.period?.number ?? null,
        clock: play.clock?.displayValue ?? '',
        down: play.start?.down > 0 ? play.start.down : null,
        distance: finite(play.start?.distance),
        downDistance: play.start?.down > 0 ? play.start?.shortDownDistanceText ?? play.start?.downDistanceText ?? null : null,
        startYL: finite(play.start?.yardLine),
        endYL: finite(play.end?.yardLine),
        yards: finite(play.statYardage),
        kind: playKind(play),
        typeText: (play.type?.text ?? '').toLowerCase(),
        text: tidyPlayText(play.text),
        scoring: play.scoringPlay === true,
        incomplete: /incomplet/i.test(play.type?.text ?? ''),
        // The next snap, as recorded with this play.
        endDown: play.end?.down > 0 ? play.end.down : null,
        endDistance: finite(play.end?.distance),
        endTeamId: play.end?.team?.id != null ? String(play.end.team.id) : null,
    };
}

const RESULT_SHORT = {
    'touchdown': 'TD', 'field goal': 'FG', 'missed fg': 'MISS', 'punt': 'PUNT',
    'fumble': 'FUM', 'interception': 'INT', 'downs': 'DOWNS', 'safety': 'SAF',
    'end of half': 'HALF', 'end of game': 'END', 'blocked fg': 'BLK', 'blocked punt': 'BLK',
};

export function parseGamecast(data) {
    const comp = data.header?.competitions?.[0] ?? {};
    const idFor = side => String((comp.competitors ?? []).find(c => c.homeAway === side)?.team?.id ?? '');
    const currentId = data.drives?.current?.id != null ? String(data.drives.current.id) : null;

    const source = [...(data.drives?.previous ?? [])];
    if (currentId && !source.some(d => String(d.id) === currentId))
        source.push(data.drives.current);

    const drives = source.map(drive => {
        const teamId = String(drive.team?.id ?? '');
        const plays = (drive.plays ?? [])
            .filter(p => !HIDDEN_PLAY.test(`${p.type?.text ?? ''} ${p.text ?? ''}`) || p.scoringPlay)
            .map(p => parsePlay(p, teamId));
        const result = drive.displayResult ?? drive.result ?? null;
        return {
            id: String(drive.id ?? ''),
            teamId,
            current: String(drive.id) === currentId,
            result,
            resultShort: result ? RESULT_SHORT[result.toLowerCase()] ?? result.toUpperCase().slice(0, 5) : null,
            description: drive.description ?? '',
            startYL: Number.isFinite(drive.start?.yardLine) ? drive.start.yardLine : plays[0]?.startYL ?? null,
            endYL: Number.isFinite(drive.end?.yardLine) ? drive.end.yardLine : plays.at(-1)?.endYL ?? null,
            period: drive.start?.period?.number ?? null,
            plays,
        };
    }).filter(d => d.plays.length > 0 || d.current);

    // Win probability after each play, tagged with its period for chart ticks.
    const periodOf = new Map();
    for (const drive of drives)
        for (const play of drive.plays)
            periodOf.set(play.id, play.period);
    const winProbability = (data.winprobability ?? [])
        .filter(w => Number.isFinite(w.homeWinPercentage))
        .map(w => ({playId: String(w.playId), home: w.homeWinPercentage, period: periodOf.get(String(w.playId)) ?? null}));

    return {awayId: idFor('away'), homeId: idFor('home'), drives, winProbability};
}

function ordinal(n) {
    return ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`;
}

// What the field should show for a game: ball spot, lines, current drive, or a
// banner between plays. Also returns the latest play so the caller can
// animate it once.
//
// The next snap comes from the latest play's end (down, distance, spot), which
// keeps the field in step with the play list. When the scoreboard is already
// past that play, its spot wins and state.pending is set until the play
// arrives. Scores reset the ball for the kick, so those use the scoreboard.
export function fieldState(game, gamecast) {
    const drives = gamecast?.drives ?? [];
    const lastPlay = drives.at(-1)?.plays.at(-1) ?? null;

    if (game.state === 'post')
        return {state: {banner: game.detail.toUpperCase() || 'FINAL'}, lastPlay};
    if (!game.spot)
        return {state: {banner: (game.detail || 'Between plays').toUpperCase()}, lastPlay};

    const fromPlay = lastPlay && Number.isFinite(lastPlay.endYL) && lastPlay.endTeamId &&
        !['touchdown', 'score'].includes(lastPlay.kind);
    const playSnap = fromPlay
        ? {yardLine: lastPlay.endYL, down: lastPlay.endDown, distance: lastPlay.endDistance, possession: lastPlay.endTeamId}
        : null;
    // The scorebug can move on before the play that moved it reaches the
    // play-by-play. Show its spot right away and flag the play as pending.
    const pending = Boolean(playSnap) && spotAhead(game.spot, playSnap);
    const snap = playSnap && !pending ? playSnap : game.spot;

    return {state: {...snapState(game, drives, snap), pending}, lastPlay};
}

function spotAhead(spot, snap) {
    const differs = (a, b) => a != null && b != null && String(a) !== String(b);
    return differs(spot.yardLine, snap.yardLine) || differs(spot.down, snap.down) ||
        differs(spot.distance, snap.distance) || differs(spot.possession, snap.possession);
}

// Where the ball sat before a play, for animating a play seen for the first
// time (for example when the gamecast opens mid-game).
export function stateBeforePlay(game, gamecast, play) {
    return snapState(game, gamecast?.drives ?? [], {
        yardLine: play.startYL,
        down: play.down,
        distance: play.distance,
        possession: play.teamId,
    });
}

function snapState(game, drives, snap) {
    const offenseId = snap.possession ?? drives.find(d => d.current)?.teamId ?? null;
    const current = drives.find(d => d.current && d.teamId === offenseId) ?? null;
    const homeOffense = offenseId === String(game.home.id);
    const toGoal = homeOffense ? 100 - snap.yardLine : snap.yardLine;

    let callout = null;
    if (snap.down)
        callout = `${ordinal(snap.down)} & ${snap.distance >= toGoal ? 'Goal' : snap.distance}`;

    return {
        ballYL: snap.yardLine,
        offenseId,
        down: snap.down,
        distance: snap.distance,
        callout,
        redZone: Boolean(snap.down) && toGoal <= 20,
        drive: current ? {startYL: current.startYL, plays: current.plays} : null,
    };
}

// How to animate a play: the flight path and the headline, if any.
export function playEvent(play) {
    const type = play.typeText ?? '';
    const text = play.text ?? '';
    let banner = null;
    let tone = 'neutral';

    if (play.kind === 'touchdown') {
        [banner, tone] = ['TOUCHDOWN', 'gold'];
    } else if (play.kind === 'turnover') {
        banner = /intercept/i.test(type + text) ? 'INTERCEPTION' : /fumble/i.test(type + text) ? 'FUMBLE' : 'TURNOVER';
        tone = 'red';
    } else if (play.kind === 'sack') {
        [banner, tone] = ['SACK', 'red'];
    } else if (/field goal/.test(type)) {
        [banner, tone] = play.scoring ? ['FIELD GOAL', 'gold'] : ['NO GOOD', 'red'];
    } else if (/safety/.test(type)) {
        [banner, tone] = ['SAFETY', 'red'];
    } else if (play.incomplete) {
        banner = 'INCOMPLETE';
    } else if (['pass', 'rush'].includes(play.kind) && (play.yards ?? 0) >= 20) {
        [banner, tone] = [`BIG PLAY  +${play.yards}`, 'yellow'];
    } else if (['pass', 'rush', 'penalty'].includes(play.kind) && (play.yards ?? 0) > 0 &&
        play.endDown === 1 && play.endTeamId === play.teamId) {
        [banner, tone] = ['FIRST DOWN', 'yellow'];
    }

    let flight = 'ground';
    if (/punt|kickoff|field goal|extra point/.test(type))
        flight = 'kick';
    else if (/pass/.test(type) && play.kind !== 'sack')
        flight = 'pass';

    return {banner, tone, flight, incomplete: play.incomplete};
}

// Lightweight play counter: about 2 KB, cached by ESPN for 10 seconds.
export function playCountUrl(gameId) {
    const id = encodeURIComponent(gameId);
    return `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/plays?limit=1`;
}

// The field just before and just after a past play, for replaying it: the
// game is rewound so that play is the latest one.
export function replayStates(game, gamecast, play) {
    const plays = gamecast.drives.flatMap(d => d.plays);
    const index = plays.findIndex(p => p.id === play.id);
    const next = plays[index + 1];
    const rewound = {
        ...game,
        state: 'in',
        spot: {
            yardLine: next?.startYL ?? play.endYL,
            down: next?.down ?? null,
            distance: next?.distance ?? null,
            possession: next?.teamId ?? play.teamId,
        },
    };
    const upTo = {
        ...gamecast,
        drives: gamecast.drives
            .map(d => ({...d, current: d.plays.some(p => p.id === play.id), plays: d.plays.filter(p => plays.indexOf(p) <= index)}))
            .filter(d => d.plays.length),
    };
    return {from: stateBeforePlay(rewound, upTo, play), to: {...fieldState(rewound, upTo).state, pending: false}};
}
