import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

// Pure Cairo drawing for the gamecast: the field, the win-probability line and
// the drive chart. No St or Clutter, so scripts/render-fixtures.js can draw
// these to PNGs outside GNOME Shell. Every yardLine counts from the home goal line (0) to the away
// goal line (100). The away end zone is drawn on the left and the home end
// zone on the right, matching the scoreboard hero above it.

const LOS_BLUE = [0.23, 0.51, 0.96];
const FIRST_DOWN_YELLOW = [0.98, 0.78, 0.1];
const INK = [0.17, 0.2, 0.25];

const KIND_COLORS = {
    touchdown: [0.93, 0.66, 0.1],
    score: [0.93, 0.66, 0.1],
    turnover: [0.84, 0.23, 0.23],
    sack: [0.84, 0.23, 0.23],
    penalty: [0.98, 0.78, 0.1],
    kick: [0.55, 0.6, 0.66],
};

export function hexRgb(hex) {
    const n = parseInt(hex ?? '5a6878', 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export function playColor(play) {
    if (KIND_COLORS[play.kind])
        return KIND_COLORS[play.kind];
    if ((play.yards ?? 0) > 0)
        return [0.18, 0.62, 0.36];
    if ((play.yards ?? 0) < 0)
        return [0.84, 0.23, 0.23];
    return [0.55, 0.6, 0.66];
}

function easeOutCubic(t) {
    return 1 - (1 - t) ** 3;
}

function easeOutBack(t) {
    const c = 1.70158;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

function clamp01(t) {
    return Math.min(1, Math.max(0, t));
}

// Progress of a sub-step running from a to b within the whole animation.
function phase(p, a, b) {
    return clamp01((p - a) / (b - a));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Blend two yard lines; if either is missing, switch halfway through.
function mixYL(a, b, t) {
    if (Number.isFinite(a) && Number.isFinite(b))
        return lerp(a, b, t);
    return t < 0.5 ? a : b;
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function textLayout(cr, text, font) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string(font));
    layout.set_text(text, -1);
    return layout;
}

// Draws text centered on (x, y); returns its pixel size.
function centeredText(cr, text, font, x, y, rgba) {
    const layout = textLayout(cr, text, font);
    const [tw, th] = layout.get_pixel_size();
    cr.setSourceRGBA(...rgba);
    cr.moveTo(x - tw / 2, y - th / 2);
    PangoCairo.show_layout(cr, layout);
    return [tw, th];
}

// f: {away, home, homeLogoPath, state, anim: {from, play, event, progress} | null}
export function drawField(f, cr, w, h) {
    const s = f.state;
    const scale = w / 120;
    const ez = scale * 10;
    const x = yl => ez + (100 - yl) * scale;
    const homeOffense = s.offenseId && s.offenseId === String(f.home.id);
    let redZoneLine = null;

    cr.save();
    roundedRect(cr, 0.5, 0.5, w - 1, h - 1, 16);
    cr.clip();

    // Frosted turf: pale mint that lets the glass read through.
    const turf = new Cairo.LinearGradient(0, 0, 0, h);
    turf.addColorStopRGBA(0, 0.66, 0.84, 0.72, 0.92);
    turf.addColorStopRGBA(1, 0.52, 0.76, 0.61, 0.92);
    cr.setSource(turf);
    cr.paint();

    for (let yl = 0; yl < 100; yl += 10) {
        if ((yl / 10) % 2 === 0)
            continue;
        cr.setSourceRGBA(1, 1, 1, 0.07);
        cr.rectangle(x(yl + 10), 0, scale * 10, h);
        cr.fill();
    }

    // Home logo watermark at midfield.
    if (f.homeLogoPath) {
        try {
            const logo = Cairo.ImageSurface.createFromPNG(f.homeLogoPath);
            const size = h * 0.46;
            const factor = size / logo.getWidth();
            cr.save();
            cr.translate(x(50) - size / 2, h / 2 - size / 2);
            cr.scale(factor, factor);
            cr.setSourceSurface(logo, 0, 0);
            cr.paintWithAlpha(0.2);
            cr.restore();
        } catch (e) {
            // Logo not cached yet; the next render picks it up.
        }
    }

    // Red zone: a red tint over green turns brown, so brighten the zone and
    // mark its 20-yard line in red instead.
    if (s.redZone && s.offenseId) {
        const [from, to] = homeOffense ? [80, 100] : [0, 20];
        cr.setSourceRGBA(1, 1, 1, 0.16);
        cr.rectangle(Math.min(x(from), x(to)), 0, Math.abs(x(to) - x(from)), h);
        cr.fill();
        redZoneLine = x(from);
    }

    // A touchdown lights up the end zone the ball finished in: yardLine 100
    // is the away end zone on the left.
    const anim = f.anim && f.anim.progress < 1 ? f.anim : null;
    const tdGlow = anim?.event.banner === 'TOUCHDOWN' ? Math.sin(phase(anim.progress, 0.45, 1) * Math.PI) : 0;
    const tdLeft = (anim?.play.endYL ?? 100) >= 50;
    drawEndZone(cr, 0, ez, h, f.away, -1, tdLeft ? tdGlow : 0);
    drawEndZone(cr, w - ez, ez, h, f.home, 1, tdLeft ? 0 : tdGlow);

    // Yard lines, hash marks and numbers.
    for (let yl = 0; yl <= 100; yl += 5) {
        const goal = yl === 0 || yl === 100;
        cr.setSourceRGBA(1, 1, 1, goal ? 0.95 : yl % 10 === 0 ? 0.75 : 0.45);
        cr.setLineWidth(goal ? 2.5 : yl % 10 === 0 ? 1.5 : 1);
        cr.moveTo(x(yl), 0);
        cr.lineTo(x(yl), h);
        cr.stroke();
    }
    cr.setSourceRGBA(1, 1, 1, 0.4);
    cr.setLineWidth(1);
    for (let yl = 1; yl < 100; yl++) {
        if (yl % 5 === 0)
            continue;
        for (const y of [h * 0.36, h * 0.64]) {
            cr.moveTo(x(yl), y - 3);
            cr.lineTo(x(yl), y + 3);
        }
        cr.moveTo(x(yl), 0);
        cr.lineTo(x(yl), 4);
        cr.moveTo(x(yl), h - 4);
        cr.lineTo(x(yl), h);
    }
    cr.stroke();
    for (let yl = 10; yl < 100; yl += 10) {
        const label = String(Math.min(yl, 100 - yl));
        centeredText(cr, label, 'Inter Bold 11', x(yl), h * 0.15, [1, 1, 1, 0.85]);
        centeredText(cr, label, 'Inter Bold 11', x(yl), h * 0.85, [1, 1, 1, 0.85]);
    }

    if (redZoneLine !== null) {
        cr.setSourceRGBA(0.84, 0.23, 0.23, 0.85);
        cr.setLineWidth(2);
        cr.moveTo(redZoneLine, 0);
        cr.lineTo(redZoneLine, h);
        cr.stroke();
    }

    if (Number.isFinite(s.ballYL) || anim)
        drawPlayState(f, anim, cr, w, h, x);
    if (anim)
        drawPlayEffects(f, anim, cr, w, h, x, tdLeft);

    if (s.pending && !s.banner)
        drawPendingTag(cr, w, f.pulse ?? 0);

    if (s.banner) {
        const layout = textLayout(cr, s.banner, 'Inter Heavy 13');
        const [tw, th] = layout.get_pixel_size();
        const bw = tw + 28;
        const bh = th + 12;
        roundedRect(cr, w / 2 - bw / 2, h / 2 - bh / 2, bw, bh, bh / 2);
        cr.setSourceRGBA(1, 1, 1, 0.88);
        cr.fill();
        cr.setSourceRGBA(...INK, 1);
        cr.moveTo(w / 2 - tw / 2, h / 2 - th / 2);
        PangoCairo.show_layout(cr, layout);
    }

    // Glass: soft top highlight and a hairline edge.
    const shine = new Cairo.LinearGradient(0, 0, 0, h * 0.45);
    shine.addColorStopRGBA(0, 1, 1, 1, 0.24);
    shine.addColorStopRGBA(1, 1, 1, 1, 0);
    cr.setSource(shine);
    cr.rectangle(0, 0, w, h * 0.45);
    cr.fill();
    cr.restore();

    roundedRect(cr, 0.5, 0.5, w - 1, h - 1, 16);
    cr.setSourceRGBA(1, 1, 1, 0.75);
    cr.setLineWidth(1);
    cr.stroke();
}

// The field shows the scoreboard's new spot, but the play that got there
// hasn't reached the play-by-play yet. pulse (0-1) throbs the dot.
function drawPendingTag(cr, w, pulse) {
    const layout = textLayout(cr, 'WAITING FOR PLAY DETAILS', 'Inter Heavy 8');
    const [tw, th] = layout.get_pixel_size();
    const dot = 3;
    const pw = tw + dot * 2 + 22;
    const ph = th + 6;
    const px = w / 2 - pw / 2;
    const py = 5;
    roundedRect(cr, px, py, pw, ph, ph / 2);
    cr.setSourceRGBA(1, 1, 1, 0.92);
    cr.fill();

    const cx = px + 9 + dot;
    const cy = py + ph / 2;
    const throb = Math.sin(pulse * Math.PI);
    cr.setSourceRGBA(0.84, 0.23, 0.23, 0.25 * (1 - throb));
    cr.arc(cx, cy, dot + 3 * throb, 0, 2 * Math.PI);
    cr.fill();
    cr.setSourceRGBA(0.84, 0.23, 0.23, 1);
    cr.arc(cx, cy, dot, 0, 2 * Math.PI);
    cr.fill();

    cr.setSourceRGBA(...INK, 1);
    cr.moveTo(cx + dot + 6, py + 3);
    PangoCairo.show_layout(cr, layout);
}

function drawEndZone(cr, left, width, h, team, rotation, glow) {
    const [r, g, b] = hexRgb(team.color);
    cr.setSourceRGBA(r, g, b, 0.88 + 0.12 * glow);
    cr.rectangle(left, 0, width, h);
    cr.fill();

    if (glow > 0) {
        cr.setSourceRGBA(1, 0.85, 0.3, 0.4 * glow);
        cr.rectangle(left, 0, width, h);
        cr.fill();
    }

    cr.save();
    cr.translate(left + width / 2, h / 2);
    cr.rotate(rotation * Math.PI / 2);
    const name = team.name.toUpperCase().split('').join(' ');
    centeredText(cr, name, 'Inter Heavy 12', 0, 0, [1, 1, 1, 0.92]);
    cr.restore();
}

// One play, as fractions of the whole animation: the ball travels, lands,
// then the lines slide to the next snap while the callout returns.
const PHASE = {travelStart: 0.04, travelEnd: 0.5, linesStart: 0.58, linesEnd: 0.8};

// A turnover's yardage is the offense's, so a gain streak would mislead.
const TURNOVERS = new Set(['INTERCEPTION', 'FUMBLE', 'TURNOVER']);
const SERIES_ENDING = new Set(['TOUCHDOWN', 'FIELD GOAL', 'NO GOOD', 'INTERCEPTION', 'FUMBLE', 'TURNOVER', 'SAFETY']);

function firstDownYL(state, homeId) {
    if (!state?.down || !Number.isFinite(state.distance) || state.distance <= 0 || !Number.isFinite(state.ballYL))
        return null;
    const target = state.offenseId === homeId ? state.ballYL + state.distance : state.ballYL - state.distance;
    return target > 0 && target < 100 ? target : null;
}

// Where the ball is at this point of the animation: yard line, height above
// the turf, opacity and tilt.
function ballPosition(f, anim) {
    const s = f.state;
    if (!anim || !Number.isFinite(anim.play.startYL))
        return {yl: s.ballYL, lift: 0, alpha: 1, tilt: 0};

    const {play, event} = anim;
    const p = anim.progress;
    const start = play.startYL;
    const attacking = play.teamId === String(f.home.id) ? 1 : -1;
    const end = event.incomplete
        ? start + attacking * Math.min(14, attacking > 0 ? 100 - start : start)
        : Number.isFinite(play.endYL) ? play.endYL : s.ballYL;

    if (p < PHASE.travelEnd) {
        const t = phase(p, PHASE.travelStart, PHASE.travelEnd);
        let lift = 0;
        let tilt = 0;
        if (event.flight === 'ground') {
            lift = Math.abs(Math.sin(t * Math.PI * 3)) * 2.5 * (1 - t);
        } else {
            const peak = event.flight === 'kick' ? 64 : Math.min(46, 10 + Math.abs(end - start) * 1.1);
            lift = peak * 4 * t * (1 - t);
            tilt = attacking * (t - 0.5) * 0.9;
        }
        const travel = event.flight === 'ground' ? easeOutCubic(t) : smoothstep(t);
        const alpha = event.incomplete ? 1 - phase(p, PHASE.travelEnd * 0.75, PHASE.travelEnd) : 1;
        return {yl: lerp(start, end, travel), lift, alpha, tilt};
    }

    const settle = smoothstep(phase(p, PHASE.linesStart, PHASE.linesEnd));
    if (event.incomplete)
        return {yl: Number.isFinite(s.ballYL) ? s.ballYL : start, lift: 0, alpha: settle, tilt: 0};
    // The next snap can be somewhere else (a touchdown resets for the kick,
    // a penalty is enforced): fade across instead of sliding.
    if (Number.isFinite(s.ballYL) && Math.abs(end - s.ballYL) > 0.5)
        return {yl: settle < 0.5 ? end : s.ballYL, lift: 0, alpha: Math.abs(settle - 0.5) * 2, tilt: 0};
    return {yl: end, lift: 0, alpha: 1, tilt: 0};
}

function drawBall(cr, bx, groundY, lift, alpha, tilt) {
    if (alpha <= 0.01)
        return;
    const grow = 1 + lift / 90;

    // Shadow stays on the turf and shrinks as the ball rises.
    cr.save();
    cr.translate(bx, groundY + 1.5);
    cr.scale(1 / grow, 0.62 / grow);
    cr.arc(0, 0, 10, 0, 2 * Math.PI);
    cr.setSourceRGBA(0, 0, 0, 0.18 * alpha);
    cr.fill();
    cr.restore();

    cr.save();
    cr.translate(bx, groundY - lift);
    cr.rotate(tilt);
    cr.scale(grow, grow);
    cr.save();
    cr.scale(1, 0.6);
    cr.arc(0, 0, 9.5, 0, 2 * Math.PI);
    cr.restore();
    cr.setSourceRGBA(0.55, 0.3, 0.14, alpha);
    cr.fillPreserve();
    cr.setSourceRGBA(0.35, 0.18, 0.08, alpha);
    cr.setLineWidth(1);
    cr.stroke();
    cr.setSourceRGBA(1, 1, 1, 0.95 * alpha);
    cr.setLineWidth(1.2);
    cr.moveTo(-4, 0);
    cr.lineTo(4, 0);
    for (const dx of [-2.5, 0, 2.5]) {
        cr.moveTo(dx, -1.8);
        cr.lineTo(dx, 1.8);
    }
    cr.stroke();
    cr.restore();
}

function drawPlayState(f, anim, cr, w, h, x) {
    const s = f.state;
    const mid = h / 2;
    const homeId = String(f.home.id);
    const p = anim?.progress ?? 1;
    const from = anim?.from ?? s;
    const lines = anim ? smoothstep(phase(p, PHASE.linesStart, PHASE.linesEnd)) : 1;
    const ball = ballPosition(f, anim);
    const landed = !anim || p >= PHASE.travelEnd;

    // Drive trail: a band from where the drive started to the ball, with a
    // dot where each play ended. The newest dot appears when the ball lands.
    const offense = (s.offenseId ?? from.offenseId) === homeId ? f.home : f.away;
    const drive = s.drive;
    if (drive && Number.isFinite(drive.startYL) && Number.isFinite(ball.yl)) {
        const x1 = x(drive.startYL);
        const x2 = x(ball.yl);
        roundedRect(cr, Math.min(x1, x2), mid - 6, Math.max(Math.abs(x2 - x1), 2), 12, 6);
        cr.setSourceRGBA(...hexRgb(offense.color), 0.3);
        cr.fill();
        for (const play of drive.plays) {
            if (!Number.isFinite(play.endYL) || (!landed && play.id === anim.play.id))
                continue;
            cr.arc(x(play.endYL), mid, 3.5, 0, 2 * Math.PI);
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.fillPreserve();
            cr.setSourceRGBA(...playColor(play), 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
    }

    // Gain or loss streak behind the ball for this play; fades once the lines move.
    if (anim && !anim.event.incomplete && anim.event.flight !== 'kick' && !TURNOVERS.has(anim.event.banner) &&
        Number.isFinite(anim.play.startYL) && Number.isFinite(anim.play.yards) && anim.play.yards !== 0) {
        const tip = landed ? anim.play.endYL : ball.yl;
        if (Number.isFinite(tip)) {
            const x1 = x(anim.play.startYL);
            const x2 = x(tip);
            const fade = 1 - phase(p, PHASE.linesEnd, 0.95);
            const color = anim.play.yards > 0 ? [0.18, 0.72, 0.4] : [0.88, 0.25, 0.25];
            roundedRect(cr, Math.min(x1, x2), mid - 3, Math.max(Math.abs(x2 - x1), 2), 6, 3);
            cr.setSourceRGBA(...color, 0.75 * fade);
            cr.fill();
        }
    }

    // Within a series the lines slide to the next snap. After a score, a kick
    // or a turnover the next snap is a different situation, so the old lines
    // fade out and the new ones fade in.
    const drawLines = (state, los, fd, alpha) => {
        if (alpha <= 0.01)
            return;
        if (fd !== null) {
            cr.setSourceRGBA(...FIRST_DOWN_YELLOW, 0.95 * alpha);
            cr.setLineWidth(3);
            cr.moveTo(x(fd), 0);
            cr.lineTo(x(fd), h);
            cr.stroke();
        }
        if (Number.isFinite(los)) {
            cr.setSourceRGBA(...LOS_BLUE, 0.95 * alpha);
            cr.setLineWidth(3);
            cr.moveTo(x(los), 0);
            cr.lineTo(x(los), h);
            cr.stroke();
        }
    };
    const fdFrom = firstDownYL(from, homeId);
    const fdTo = firstDownYL(s, homeId);
    const sameSeries = anim && from.offenseId && from.offenseId === s.offenseId &&
        anim.event.flight !== 'kick' && !SERIES_ENDING.has(anim.event.banner);
    if (!anim || sameSeries) {
        const fd = fdFrom !== null && fdTo !== null ? lerp(fdFrom, fdTo, lines) : lines < 0.5 ? fdFrom : fdTo;
        drawLines(s, mixYL(from.ballYL, s.ballYL, lines), fd, 1);
    } else {
        drawLines(from, from.ballYL, fdFrom, 1 - phase(p, PHASE.travelEnd + 0.04, PHASE.linesStart + 0.06));
        drawLines(s, s.ballYL, fdTo, phase(p, PHASE.linesEnd - 0.1, PHASE.linesEnd + 0.04));
    }

    if (Number.isFinite(ball.yl))
        drawBall(cr, x(ball.yl), mid, ball.lift, ball.alpha, ball.tilt);

    // Down-and-distance callout: the old one leaves as the play starts, the new
    // one arrives with the lines.
    const callout = anim && p < PHASE.linesStart ? from.callout : s.callout;
    const calloutAlpha = !anim ? 1 : p < PHASE.linesStart
        ? 1 - phase(p, 0, PHASE.travelStart * 2)
        : phase(p, PHASE.linesEnd - 0.05, PHASE.linesEnd + 0.08);
    const calloutYL = p < PHASE.linesStart ? from.ballYL : s.ballYL;
    if (callout && calloutAlpha > 0.01 && Number.isFinite(calloutYL)) {
        const layout = textLayout(cr, callout, 'Inter Bold 9');
        const [tw, th] = layout.get_pixel_size();
        const pw = tw + 14;
        const ph = th + 6;
        // Stay inside the field of play so the end-zone name stays readable.
        const ez = w / 12;
        const px = Math.min(Math.max(x(calloutYL) - pw / 2, ez + 4), w - ez - pw - 4);
        const py = mid - 16 - ph;
        roundedRect(cr, px, py, pw, ph, ph / 2);
        cr.setSourceRGBA(1, 1, 1, 0.92 * calloutAlpha);
        cr.fill();
        cr.setSourceRGBA(...INK, calloutAlpha);
        cr.moveTo(px + 7, py + 3);
        PangoCairo.show_layout(cr, layout);
    }
}

const BANNER_TONES = {
    gold: {fill: [0.93, 0.64, 0.08], text: [1, 1, 1]},
    red: {fill: [0.84, 0.23, 0.23], text: [1, 1, 1]},
    yellow: {fill: [0.99, 0.8, 0.12], text: INK},
    neutral: {fill: [1, 1, 1], text: INK},
};

// Yardage pop, headline banner and the touchdown burst.
function drawPlayEffects(f, anim, cr, w, h, x, tdLeft) {
    const {play, event} = anim;
    const p = anim.progress;
    const mid = h / 2;

    // "+12" rises from where the play ended.
    if (!event.incomplete && event.flight !== 'kick' && !TURNOVERS.has(event.banner) && Number.isFinite(play.endYL) &&
        Number.isFinite(play.yards) && play.yards !== 0) {
        const alpha = phase(p, PHASE.travelEnd - 0.02, PHASE.travelEnd + 0.08) * (1 - phase(p, 0.85, 0.97));
        if (alpha > 0.01) {
            const rise = 16 * phase(p, PHASE.travelEnd - 0.02, 0.97);
            const text = `${play.yards > 0 ? '+' : '−'}${Math.abs(play.yards)}`;
            const color = play.yards > 0 ? [0.1, 0.5, 0.26] : [0.78, 0.16, 0.16];
            const ez = w / 12;
            const px = Math.min(Math.max(x(play.endYL), ez + 16), w - ez - 16);
            centeredText(cr, text, 'Inter Heavy 15', px + 1, mid + 30 - rise + 1, [1, 1, 1, 0.8 * alpha]);
            centeredText(cr, text, 'Inter Heavy 15', px, mid + 30 - rise, [...color, alpha]);
        }
    }

    // Touchdown burst from the end zone the ball finished in.
    if (event.banner === 'TOUCHDOWN') {
        const t = phase(p, 0.46, 1);
        if (t > 0 && t < 1) {
            const ez = w / 12;
            const cx = tdLeft ? ez / 2 : w - ez / 2;
            const inward = tdLeft ? 1 : -1;
            const scorer = play.teamId === String(f.home.id) ? f.home : f.away;
            const colors = [hexRgb(scorer.color), [0.98, 0.78, 0.2], [1, 1, 1]];
            for (let i = 0; i < 42; i++) {
                const angle = i * 2.39996;
                const speed = 50 + (i * 37) % 90;
                const dist = speed * easeOutCubic(t);
                const px = cx + inward * Math.abs(Math.cos(angle)) * dist * 1.4;
                const py = mid + Math.sin(angle) * dist * 0.9 + 40 * t * t;
                cr.setSourceRGBA(...colors[i % 3], 1 - t);
                cr.arc(px, py, 2 + (i % 3), 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }

    // Headline banner pops in as the ball lands and fades at the end.
    if (event.banner) {
        const appear = phase(p, PHASE.travelEnd, PHASE.travelEnd + 0.12);
        const alpha = Math.min(1, appear * 3) * (1 - phase(p, 0.9, 1));
        if (alpha > 0.01) {
            const big = event.banner === 'TOUCHDOWN';
            const text = big ? event.banner.split('').join(' ') : event.banner;
            const tone = BANNER_TONES[event.tone] ?? BANNER_TONES.neutral;
            const layout = textLayout(cr, text, big ? 'Inter Heavy 20' : 'Inter Heavy 14');
            const [tw, th] = layout.get_pixel_size();
            const scale = 0.6 + 0.4 * easeOutBack(appear);
            const bw = tw + (big ? 40 : 28);
            const bh = th + (big ? 16 : 12);
            cr.save();
            cr.translate(w / 2, h * 0.27);
            cr.scale(scale, scale);
            roundedRect(cr, -bw / 2 + 1, -bh / 2 + 3, bw, bh, bh / 2);
            cr.setSourceRGBA(0, 0, 0, 0.12 * alpha);
            cr.fill();
            roundedRect(cr, -bw / 2, -bh / 2, bw, bh, bh / 2);
            cr.setSourceRGBA(...tone.fill, 0.95 * alpha);
            cr.fill();
            cr.setSourceRGBA(...tone.text, alpha);
            cr.moveTo(-tw / 2, -th / 2);
            PangoCairo.show_layout(cr, layout);
            cr.restore();
        }
    }
}

// Home win probability over the game. The away team is at the top, the home
// team at the bottom, and the area between the line and 50% takes the color
// of whoever is ahead.
export function drawWinProbability(c, cr, w, h) {
    const points = c.points;
    const left = 34;
    const top = 4;
    const bottom = h - 14;
    const plotW = w - left - 4;
    const plotH = bottom - top;
    const mid = top + plotH / 2;
    const px = i => left + (points.length > 1 ? i / (points.length - 1) : 1) * plotW;
    const py = home => top + home * plotH;

    centeredText(cr, c.away.abbr, 'Inter Bold 9', left / 2 - 2, top + 6, [...hexRgb(c.away.color), 1]);
    centeredText(cr, c.home.abbr, 'Inter Bold 9', left / 2 - 2, bottom - 6, [...hexRgb(c.home.color), 1]);

    // Quarter ticks.
    let lastPeriod = points[0]?.period ?? null;
    points.forEach((point, i) => {
        if (point.period && lastPeriod && point.period !== lastPeriod) {
            cr.setSourceRGBA(...INK, 0.12);
            cr.setLineWidth(1);
            cr.moveTo(px(i), top);
            cr.lineTo(px(i), bottom);
            cr.stroke();
            const label = point.period > 4 ? 'OT' : `Q${point.period}`;
            centeredText(cr, label, 'Inter 8', px(i), h - 6, [...INK, 0.45]);
        }
        if (point.period)
            lastPeriod = point.period;
    });

    cr.setSourceRGBA(...INK, 0.22);
    cr.setLineWidth(1);
    cr.setDash([3, 3], 0);
    cr.moveTo(left, mid);
    cr.lineTo(left + plotW, mid);
    cr.stroke();
    cr.setDash([], 0);

    if (points.length < 2)
        return;

    const tracePath = () => {
        cr.moveTo(px(0), mid);
        points.forEach((point, i) => cr.lineTo(px(i), py(point.home)));
        cr.lineTo(px(points.length - 1), mid);
        cr.closePath();
    };
    for (const [team, clipTop, clipHeight] of [[c.away, top, mid - top], [c.home, mid, bottom - mid]]) {
        cr.save();
        cr.rectangle(left, clipTop, plotW, clipHeight);
        cr.clip();
        tracePath();
        cr.setSourceRGBA(...hexRgb(team.color), 0.28);
        cr.fill();
        cr.restore();
    }

    points.forEach((point, i) => (i === 0 ? cr.moveTo : cr.lineTo).call(cr, px(i), py(point.home)));
    cr.setSourceRGBA(...INK, 0.85);
    cr.setLineWidth(1.6);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.stroke();

    const last = points.at(-1);
    cr.arc(px(points.length - 1), py(last.home), 3.5, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.fillPreserve();
    cr.setSourceRGBA(...INK, 0.9);
    cr.setLineWidth(1.5);
    cr.stroke();
}

// One thin bar per drive, drawn on the same yard scale as the field so it
// lines up underneath it.
export function drawDriveChart(c, cr, w) {
    const scale = w / 120;
    const ez = scale * 10;
    const x = yl => ez + (100 - yl) * scale;

    for (const yl of [0, 50, 100]) {
        cr.setSourceRGBA(...INK, yl === 50 ? 0.1 : 0.18);
        cr.setLineWidth(1);
        cr.moveTo(x(yl), 0);
        cr.lineTo(x(yl), c.drives.length * 10 + 6);
        cr.stroke();
    }

    c.drives.forEach((drive, i) => {
        const y = 3 + i * 10;
        const team = drive.teamId === String(c.home.id) ? c.home : c.away;
        const start = drive.startYL;
        const end = drive.endYL ?? drive.startYL;
        if (!Number.isFinite(start) || !Number.isFinite(end))
            return;
        const x1 = Math.min(x(start), x(end));
        const x2 = Math.max(x(start), x(end));
        roundedRect(cr, x1, y, Math.max(x2 - x1, 4), 6, 3);
        cr.setSourceRGBA(...hexRgb(team.color), drive.current ? 0.55 : 0.85);
        cr.fill();

        const label = drive.current ? 'NOW' : drive.resultShort;
        if (!label)
            return;
        const good = ['TD', 'FG'].includes(label);
        const bad = ['INT', 'FUM', 'DOWNS', 'MISS', 'SAF', 'BLK'].includes(label);
        const color = good ? [0.13, 0.47, 0.29] : bad ? [0.78, 0.18, 0.18] : [...INK];
        // Label goes past the end the drive was heading toward.
        const towardLeft = team === c.home;
        const layout = textLayout(cr, label, 'Inter Bold 7');
        const [tw] = layout.get_pixel_size();
        const lx = towardLeft ? Math.max(x1 - tw - 4, 0) : Math.min(x2 + 4, w - tw);
        cr.setSourceRGBA(...color, 0.9);
        cr.moveTo(lx, y - 2);
        PangoCairo.show_layout(cr, layout);
    });
}

export function driveChartHeight(drives) {
    return Math.max(drives.length, 1) * 10 + 6;
}
