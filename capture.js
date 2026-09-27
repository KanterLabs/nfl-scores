import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

// Development tool: the running extension photographs its own popup for the
// README. Triggered by scripts/screenshots.sh through the screenshot-dir key.
// GNOME Shell promisifies Shell.Screenshot.screenshot_area at startup.

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {replayStates, playEvent} = await import(`./games.js?v=${BUILD}`);

const MARGIN = 40;

// A soft pearl-blue backdrop behind the popup while capturing, so the glass
// has something pleasant to blur and no real windows end up in the images.
const CaptureBackdrop = GObject.registerClass({GTypeName: `NflCaptureBackdrop_${BUILD}`},
class CaptureBackdrop extends St.DrawingArea {
    _init() {
        super._init({reactive: false});
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const base = new Cairo.LinearGradient(0, 0, w, h);
        base.addColorStopRGB(0, 0.93, 0.95, 0.99);
        base.addColorStopRGB(1, 0.8, 0.87, 0.95);
        cr.setSource(base);
        cr.paint();
        for (const [fx, fy, fr, r, g, b, a] of [
            [0.28, 0.2, 0.45, 0.62, 0.76, 0.95, 0.55],
            [0.75, 0.35, 0.4, 0.86, 0.8, 0.97, 0.5],
            [0.55, 0.8, 0.5, 0.7, 0.88, 0.93, 0.5],
            [0.12, 0.75, 0.3, 0.98, 0.9, 0.84, 0.45],
        ]) {
            const blob = new Cairo.RadialGradient(fx * w, fy * h, 0, fx * w, fy * h, fr * Math.max(w, h));
            blob.addColorStopRGBA(0, r, g, b, a);
            blob.addColorStopRGBA(1, r, g, b, 0);
            cr.setSource(blob);
            cr.paint();
        }
        cr.$dispose();
    }
});

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(test, timeoutMs) {
    const start = Date.now();
    while (!test() && Date.now() - start < timeoutMs)
        await wait(100);
    return test();
}

function rectOf(actor, margin = 0) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x: Math.round(x - margin), y: Math.round(y - margin), w: Math.round(w + margin * 2), h: Math.round(h + margin * 2)};
}

async function shoot(rect, path) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    try {
        await new Shell.Screenshot().screenshot_area(rect.x, rect.y, rect.w, rect.h, stream);
    } finally {
        stream.close(null);
    }
}

// Best game to show: one in play with the most drives, else the latest final.
function pickGame(games) {
    const inPlay = games.filter(g => g.state === 'in' && g.spot);
    if (inPlay.length)
        return inPlay[0];
    return games.find(g => g.state === 'in') ?? games.find(g => g.state === 'post') ?? games[0];
}

// Replays the game's latest touchdown (or its latest headline play) while
// recording the hero and field, for the README GIF. Frames are written with a
// concat list that keeps their real timing.
async function recordReplay(board, game, dir) {
    const plays = board._summaries.get(game.id)?.gamecast.drives.flatMap(d => d.plays) ?? [];
    const play = plays.findLast(p => p.kind === 'touchdown' && Number.isFinite(p.startYL)) ??
        plays.findLast(p => playEvent(p).banner && Number.isFinite(p.startYL)) ??
        plays.findLast(p => Number.isFinite(p.startYL));
    if (!play || !board._field)
        return null;

    const framesDir = `${dir}/.frames`;
    GLib.mkdir_with_parents(framesDir, 0o755);
    // Hero, field and legend. The nav buttons sit 12px above the hero.
    const top = rectOf(board._body.get_child_at_index(1));
    const field = rectOf(board._field);
    const legend = board._field.get_next_sibling();
    const bottom = legend ? rectOf(legend) : field;
    const rect = {x: field.x - 10, y: top.y - 8, w: field.w + 20, h: bottom.y + bottom.h - top.y + 16};

    const {from, to} = replayStates(game, board._summaries.get(game.id).gamecast, play);
    const event = playEvent(play);
    board._field.playTransition(from, to, play, event);

    const duration = event.banner === 'TOUCHDOWN' ? 3400 : event.banner ? 2600 : 2000;
    const start = Date.now();
    const lines = [];
    let last = start;
    // The still is the frame closest to 62% through: ball down, banner up.
    const stillAt = duration * 0.62;
    let still = null;
    for (let i = 0; Date.now() - start < duration + 700; i++) {
        const name = `${String(i).padStart(4, '0')}.png`;
        const shotAt = Date.now() - start;
        await shoot(rect, `${framesDir}/${name}`);
        const now = Date.now();
        lines.push(`file '${name}'`, `duration ${((now - last) / 1000).toFixed(3)}`);
        last = now;
        if (!still || Math.abs(shotAt - stillAt) < Math.abs(still.at - stillAt))
            still = {name, at: shotAt};
    }
    GLib.file_set_contents(`${framesDir}/frames.txt`, `${lines.join('\n')}\n`);
    if (still) {
        Gio.File.new_for_path(`${framesDir}/${still.name}`).copy(
            Gio.File.new_for_path(`${dir}/touchdown.png`), Gio.FileCopyFlags.OVERWRITE, null, null);
    }
    return {play, event, duration, start};
}

export async function captureScreenshots(board, dir) {
    GLib.mkdir_with_parents(dir, 0o755);
    const backdrop = new CaptureBackdrop();
    board._backdrop.insert_child_at_index(backdrop, 0);

    try {
        board.close();
        await wait(300);
        board._gameId = null;
        board.open();
        await waitFor(() => board._data, 10000);
        await wait(2500); // logos and the open animation
        await shoot(rectOf(board._popup, MARGIN), `${dir}/scoreboard.png`);

        const games = board._data?.games ?? [];
        const game = pickGame(games);
        if (game) {
            board._tabs.delete(game.id);
            board._showGame(game.id);
            await waitFor(() => board._summaries.has(game.id), 10000);
            await wait(4000); // the intro play animation
            await shoot(rectOf(board._popup, MARGIN), `${dir}/gamecast.png`);

            const replay = await recordReplay(board, game, dir);
            if (replay)
                console.log(`NFL Scores: recorded replay of ${replay.play.text}`);
            await wait(600);

            // Further down the gamecast: the plays card at the top.
            const plays = board._field.get_next_sibling()?.get_next_sibling();
            board._scroll.vadjustment.value = plays ? plays.get_allocation_box().y1 - 4 : board._field.height;
            await wait(500);
            await shoot(rectOf(board._popup, MARGIN), `${dir}/plays.png`);

            board._tabs.set(game.id, 'box');
            board._render();
            board._restoreScroll(0);
            await wait(800);
            await shoot(rectOf(board._popup, MARGIN), `${dir}/boxscore.png`);
            board._tabs.delete(game.id);
        }

        const upcoming = games.find(g => g.state === 'pre');
        if (upcoming) {
            board._showGame(upcoming.id);
            await waitFor(() => board._summaries.has(upcoming.id), 10000);
            await wait(1500);
            await shoot(rectOf(board._popup, MARGIN), `${dir}/matchup.png`);
        }

        board._showList();
        await wait(300);
    } finally {
        board.close();
        await wait(300);
        backdrop.destroy();
    }
}
