import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// St widgets around draw.js. The field owns its play animation timeline.

const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {drawField, drawWinProbability, drawDriveChart, driveChartHeight} =
    await import(`./draw.js?v=${BUILD}`);

function paint(actor, draw) {
    const cr = actor.get_context();
    const [w, h] = actor.get_surface_size();
    try {
        draw(cr, w, h);
    } catch (e) {
        console.warn(`NFL Scores: ${actor.constructor.name} draw failed: ${e.message}`);
    }
    cr.$dispose();
}

// Lives across popup refreshes (the scoreboard re-parents it) so a refresh
// never cuts a play animation short.
const FieldView = GObject.registerClass({GTypeName: `NflFieldView_${BUILD}`},
class FieldView extends St.DrawingArea {
    _init({width, height, away, home}) {
        super._init({style_class: 'nfl-field', width, height});
        this._props = {away, home, homeLogoPath: null, state: {}, anim: null, pulse: 0};
        this._timeline = null;
        this._pulse = null;
        this.connect('destroy', () => {
            this._timeline?.stop();
            this._timeline = null;
            this._pulse?.stop();
            this._pulse = null;
        });
    }

    setHomeLogo(path) {
        if (path === this._props.homeLogoPath)
            return;
        this._props.homeLogoPath = path;
        this.queue_repaint();
    }

    // state: {ballYL, offenseId, down, distance, callout, redZone, banner,
    //         drive: {startYL, plays}, pending}. Leaves a running animation
    // alone; it already ends on this state.
    setState(state) {
        this._props.state = state;
        this._syncPulse();
        this.queue_repaint();
    }

    // Throb the "play in progress" dot only while it is showing.
    _syncPulse() {
        const pending = Boolean(this._props.state.pending);
        if (pending === Boolean(this._pulse))
            return;
        if (!pending) {
            this._pulse.stop();
            this._pulse = null;
            this._props.pulse = 0;
            return;
        }
        this._pulse = new Clutter.Timeline({actor: this, duration: 1200, repeat_count: -1});
        this._pulse.connect('new-frame', timeline => {
            this._props.pulse = timeline.get_progress();
            // A running play animation already repaints every frame.
            if (!this._timeline)
                this.queue_repaint();
        });
        this._pulse.start();
    }

    // Animate one play from the field before it (from) to after it (to).
    // event comes from games.js playEvent().
    playTransition(from, to, play, event) {
        const props = this._props;
        props.state = to;
        props.anim = {from, play, event, progress: 0};
        this._syncPulse();

        let duration = 2000;
        if (event.banner === 'TOUCHDOWN')
            duration = 3400;
        else if (event.banner)
            duration = 2600;

        this._timeline?.stop();
        this._timeline = new Clutter.Timeline({actor: this, duration});
        this._timeline.connect('new-frame', timeline => {
            if (props.anim)
                props.anim.progress = timeline.get_progress();
            this.queue_repaint();
        });
        this._timeline.connect('completed', () => {
            props.anim = null;
            this._timeline = null;
            this.queue_repaint();
        });
        this._timeline.start();
    }

    vfunc_repaint() {
        paint(this, (cr, w, h) => drawField(this._props, cr, w, h));
    }
});

const WinProbabilityChart = GObject.registerClass({GTypeName: `NflWinProbabilityChart_${BUILD}`},
class WinProbabilityChart extends St.DrawingArea {
    _init({width, height, away, home, points}) {
        super._init({style_class: 'nfl-winprob-chart', width, height});
        this._props = {away, home, points};
    }

    vfunc_repaint() {
        paint(this, (cr, w, h) => drawWinProbability(this._props, cr, w, h));
    }
});

const DriveChart = GObject.registerClass({GTypeName: `NflDriveChart_${BUILD}`},
class DriveChart extends St.DrawingArea {
    _init({width, away, home, drives}) {
        super._init({style_class: 'nfl-drive-chart', width, height: driveChartHeight(drives)});
        this._props = {away, home, drives};
    }

    vfunc_repaint() {
        paint(this, (cr, w) => drawDriveChart(this._props, cr, w));
    }
});

export {FieldView, WinProbabilityChart, DriveChart};
