// Render the gamecast drawings for every saved fixture to /tmp/nfl-render/*.png
// so the field can be checked without GNOME Shell. Run with gjs:
//   gjs -m scripts/render-fixtures.js [--frames] [--module-dir DIR]
//       [--output-dir DIR] [fixtures dir]
// --frames also draws play animations as filmstrips (one row per moment).
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const WIDTH = 708;
const FIELD_HEIGHT = 200;
const PROB_HEIGHT = 84;
const GAP = 14;

const decoder = new TextDecoder();
const read = path => JSON.parse(decoder.decode(GLib.file_get_contents(path)[1]));
const positional = [];
let frames = false;
let moduleDir = null;
let out = '/tmp/nfl-render';
for (let i = 0; i < ARGV.length; i++) {
    const arg = ARGV[i];
    if (arg === '--frames') {
        frames = true;
    } else if (arg === '--module-dir') {
        moduleDir = ARGV[++i];
    } else if (arg === '--output-dir') {
        out = ARGV[++i];
    } else if (!arg.startsWith('--')) {
        positional.push(arg);
    }
}
const scriptDir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
moduleDir ??= GLib.build_filenamev([scriptDir, '..']);
const moduleUri = name => GLib.filename_to_uri(GLib.build_filenamev([moduleDir, name]), null);
const {parseScoreboard, parseGamecast, fieldState, replayStates, playEvent} = await import(moduleUri('games.js'));
const {drawField, drawWinProbability, drawDriveChart, driveChartHeight} = await import(moduleUri('draw.js'));
const dir = positional[0] ?? `${scriptDir}/../fixtures`;
GLib.mkdir_with_parents(out, 0o755);

const files = [];
const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
for (let info; (info = enumerator.next_file(null));)
    files.push(info.get_name());
const scoreboardFile = files.filter(f => f.startsWith('scoreboard-')).sort().at(-1);
const games = parseScoreboard(read(`${dir}/${scoreboardFile}`)).games;
const logoDir = `${GLib.get_user_cache_dir()}/nfl-scores/logos`;

for (const name of files.filter(f => f.startsWith('summary-') && !f.includes('-pre-'))) {
    const id = name.split('-')[1];
    const game = games.find(g => g.id === id);
    if (!game)
        continue;
    const gamecast = parseGamecast(read(`${dir}/${name}`));
    const {state, lastPlay} = fieldState(game, gamecast);
    const logo = `${logoDir}/${game.home.abbr.toLowerCase()}.png`;
    const chartHeight = driveChartHeight(gamecast.drives);
    const height = FIELD_HEIGHT + PROB_HEIGHT + chartHeight + GAP * 4;

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, WIDTH + GAP * 2, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(0.95, 0.96, 0.98);
    cr.paint();

    cr.translate(GAP, GAP);
    drawField({
        away: game.away, home: game.home,
        homeLogoPath: GLib.file_test(logo, GLib.FileTest.EXISTS) ? logo : null,
        state, anim: null,
    }, cr, WIDTH, FIELD_HEIGHT);

    cr.translate(0, FIELD_HEIGHT + GAP);
    drawWinProbability({away: game.away, home: game.home, points: gamecast.winProbability}, cr, WIDTH, PROB_HEIGHT);

    cr.translate(0, PROB_HEIGHT + GAP);
    drawDriveChart({away: game.away, home: game.home, drives: gamecast.drives}, cr, WIDTH);

    const path = `${out}/${game.away.abbr}-at-${game.home.abbr}-${game.state}.png`;
    surface.writeToPNG(path);
    cr.$dispose();
    print(`${path}  ball=${state.ballYL ?? '-'} ${state.callout ?? state.banner ?? ''}  last=${lastPlay?.kind ?? '-'}`);
}

// Filmstrips: a few kinds of play from each game, drawn at several moments.
const MOMENTS = [0.12, 0.3, 0.5, 0.62, 0.72, 0.86];
const WANTED = [
    ['last', () => true],
    ['touchdown', (p, e) => e.banner === 'TOUCHDOWN' && e.flight === 'pass'],
    ['incomplete', (p, e) => e.incomplete],
    ['first-down', (p, e) => e.banner === 'FIRST DOWN' && e.flight === 'ground'],
    ['interception', (p, e) => e.banner === 'INTERCEPTION'],
    ['field-goal', (p, e) => e.banner === 'FIELD GOAL'],
];

if (frames) {
    for (const name of files.filter(f => f.startsWith('summary-') && !f.includes('-pre-'))) {
        const id = name.split('-')[1];
        const game = games.find(g => g.id === id);
        if (!game)
            continue;
        const gamecast = parseGamecast(read(`${dir}/${name}`));
        const plays = gamecast.drives.flatMap(d => d.plays);
        const logo = `${logoDir}/${game.home.abbr.toLowerCase()}.png`;

        for (const [label, test] of WANTED) {
            const play = label === 'last' ? plays.at(-1)
                : plays.find(pl => test(pl, playEvent(pl)));
            if (!play || !Number.isFinite(play.startYL))
                continue;
            // Pretend this play just happened: the field before it and after it.
            const {from, to} = replayStates(game, gamecast, play);
            const event = playEvent(play);

            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, WIDTH + GAP * 2, MOMENTS.length * (FIELD_HEIGHT + GAP) + GAP);
            const cr = new Cairo.Context(surface);
            cr.setSourceRGB(0.95, 0.96, 0.98);
            cr.paint();
            MOMENTS.forEach((progress, i) => {
                cr.save();
                cr.translate(GAP, GAP + i * (FIELD_HEIGHT + GAP));
                drawField({
                    away: game.away, home: game.home,
                    homeLogoPath: GLib.file_test(logo, GLib.FileTest.EXISTS) ? logo : null,
                    state: to, anim: {from, play, event, progress},
                }, cr, WIDTH, FIELD_HEIGHT);
                cr.restore();
            });
            const path = `${out}/frames-${game.away.abbr}-${game.home.abbr}-${label}.png`;
            surface.writeToPNG(path);
            cr.$dispose();
            print(`${path}  ${event.banner ?? '-'} ${event.flight}  ${play.startYL}→${play.endYL}  ${play.text.slice(0, 60)}`);
        }
    }
}
