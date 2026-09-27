import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// extension.js imports this module as scoreboard.js?v=<mtime>; pass the same
// version on so an edit to games.js is picked up by a reload too.
const BUILD = import.meta.url.match(/[?&]v=(\d+)/)?.[1] ?? '0';
const {
    parseScoreboard, parseSummary, parseGamecast, fieldState, stateBeforePlay, playEvent,
    kindLabel, summaryUrl, playCountUrl, logoUrl,
} = await import(`./games.js?v=${BUILD}`);
const {FieldView, WinProbabilityChart, DriveChart} = await import(`./field.js?v=${BUILD}`);

const SCOREBOARD_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const LIVE_REFRESH_SECONDS = 20;
// A live game's gamecast wants new plays sooner.
const GAMECAST_REFRESH_SECONDS = 15;
// The scorebug is ahead of the play-by-play; check back soon for the play.
const PENDING_REFRESH_SECONDS = 5;
// While a live gamecast is open, a ~2 KB play count is checked this often and
// a new play triggers an immediate refresh. ESPN caches it for 10 seconds.
const PLAY_CHECK_SECONDS = 5;
const FRESH_PLAY_MS = 12000;
const FIELD_HEIGHT = 200;
const WIN_PROBABILITY_HEIGHT = 84;
const IDLE_REFRESH_SECONDS = 300;
const SCORE_FLASH_MS = 30000;

const GAME_WIDTH = 348;
const GAME_GAP = 12;
const POPUP_PADDING = 16;
// Matches .nfl-body padding-right; keeps the scrollbar off the right column.
const SCROLLBAR_GUTTER = 10;
// .nfl-popup has a 1px border on each side.
const POPUP_BORDER = 1;
const POPUP_WIDTH = GAME_WIDTH * 2 + GAME_GAP + POPUP_PADDING * 2 + SCROLLBAR_GUTTER + POPUP_BORDER * 2;
// Detail view: full content width, and each half of a two-column row.
const CONTENT_WIDTH = GAME_WIDTH * 2 + GAME_GAP;
const DETAIL_CARD_PADDING = 14;
const HALF_BAR_WIDTH = (CONTENT_WIDTH - GAME_GAP) / 2 - DETAIL_CARD_PADDING * 2;
const FULL_BAR_WIDTH = CONTENT_WIDTH - DETAIL_CARD_PADDING * 2;
const SUMMARY_CACHE_SIZE = 6;

const decoder = new TextDecoder('utf-8');

// The extension's own schema, loaded from next to this module so the
// reloadable code can read it without going through extension.js.
function loadSettings() {
    const dir = Gio.File.new_for_uri(import.meta.url.split('?')[0]).get_parent().get_child('schemas');
    const source = Gio.SettingsSchemaSource.new_from_directory(
        dir.get_path(), Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.nfl-scores', false);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function isCancelled(e) {
    return e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function formatKickoff(ms) {
    const when = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const today = GLib.DateTime.new_now_local();
    const sameDay = when.get_year() === today.get_year() &&
        when.get_day_of_year() === today.get_day_of_year();
    return when.format(sameDay ? '%-l:%M %p' : '%a %-l:%M %p');
}

// Team logos are fetched once at 96px and kept in ~/.cache/nfl-scores/logos.
class LogoCache {
    constructor(session, cancellable, onLoaded) {
        this._session = session;
        this._cancellable = cancellable;
        this._onLoaded = onLoaded;
        this._pending = new Set();
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'nfl-scores', 'logos']));
    }

    path(abbr) {
        const file = this._dir.get_child(`${abbr.toLowerCase()}.png`);
        return file.query_exists(null) ? file.get_path() : null;
    }

    lookup(abbr) {
        const file = this._dir.get_child(`${abbr.toLowerCase()}.png`);
        if (file.query_exists(null))
            return new Gio.FileIcon({file});
        this._download(abbr, file);
        return null;
    }

    _download(abbr, file) {
        if (this._pending.has(abbr))
            return;
        this._pending.add(abbr);

        const message = Soup.Message.new('GET', logoUrl(abbr));
        this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== 200)
                    return;
                GLib.mkdir_with_parents(this._dir.get_path(), 0o755);
                file.replace_contents(bytes.get_data(), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._pending.delete(abbr);
                this._onLoaded();
            } catch (e) {
                if (!isCancelled(e))
                    console.warn(`NFL Scores: logo ${abbr} failed: ${e.message}`);
            }
        });
    }
}

export class Scoreboard {
    constructor() {
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._logos = new LogoCache(this._session, this._cancellable, () => this._queueRender());
        this._data = null;
        this._error = null;
        this._updatedAt = null;
        this._scores = new Map();
        this._flashUntil = new Map();
        this._isOpen = false;
        // The open game survives close/reopen so Super+F can peek at one game.
        this._gameId = null;
        this._listScroll = 0;
        this._summaries = new Map();
        this._summaryError = null;
        this._tabs = new Map();
        this._openDrives = new Map();
        // Per game: the play and field state last drawn, to animate the next one.
        this._shownPlay = new Map();
        this._freshPlay = new Map();
        this._playCounts = new Map();
        this._field = null;
        this._fieldGameId = null;
        this._fieldPending = false;

        this._buildUi();

        // scripts/screenshots.sh sets screenshot-dir to capture README images.
        this._settings = loadSettings();
        this._settings?.connectObject('changed::screenshot-dir', () => this._onScreenshotRequest(), this);
    }

    async _onScreenshotRequest() {
        const dir = this._settings.get_string('screenshot-dir');
        if (!dir || this._capturing)
            return;
        this._capturing = true;
        try {
            const {captureScreenshots} = await import(`./capture.js?v=${BUILD}`);
            await captureScreenshots(this, dir);
        } catch (e) {
            console.warn(`NFL Scores: screenshots failed: ${e.message}`);
            GLib.file_set_contents(`${dir}/error.txt`, `${e.message}\n${e.stack}\n`);
        } finally {
            this._capturing = false;
            this._settings?.set_string('screenshot-dir', '');
        }
    }

    _buildUi() {
        this._backdrop = new St.Widget({
            reactive: true,
            can_focus: true,
            visible: false,
        });
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._backdrop.connect('button-press-event', (_actor, event) => this._onBackdropPress(event));
        this._backdrop.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._popup = new St.BoxLayout({
            style_class: 'nfl-popup',
            orientation: Clutter.Orientation.VERTICAL,
            width: POPUP_WIDTH,
            reactive: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });
        // Full brightness: the blur covers the popup's whole rectangle, and any
        // darkening shows as grey squares outside the rounded corners.
        this._popup.add_effect(new Shell.BlurEffect({
            name: 'nfl-scores-glass-blur',
            mode: Shell.BlurMode.BACKGROUND,
            radius: 24,
            brightness: 1.0,
        }));
        this._backdrop.add_child(this._popup);

        const header = new St.BoxLayout({style_class: 'nfl-header'});
        const titles = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titles.add_child(new St.Label({text: 'NFL', style_class: 'nfl-title'}));
        this._subtitle = new St.Label({text: 'Scoreboard', style_class: 'nfl-subtitle'});
        titles.add_child(this._subtitle);
        header.add_child(titles);
        header.add_child(new St.Widget({x_expand: true}));

        this._livePill = new St.BoxLayout({
            style_class: 'nfl-live-pill',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._livePill.add_child(new St.Widget({
            style_class: 'nfl-live-dot',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._liveCount = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._livePill.add_child(this._liveCount);
        header.add_child(this._livePill);

        this._updated = new St.Label({
            style_class: 'nfl-updated',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._updated);
        this._popup.add_child(header);

        this._body = new St.BoxLayout({
            style_class: 'nfl-body',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'nfl-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._body,
        });
        this._popup.add_child(this._scroll);

        Main.layoutManager.uiGroup.add_child(this._backdrop);
    }

    toggle() {
        if (this._isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._isOpen)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        this._popup.set_position(
            Math.round(monitor.x + (monitor.width - POPUP_WIDTH) / 2),
            Math.round(monitor.y + monitor.height * 0.1));
        this._scroll.style = `max-height: ${Math.round(monitor.height * 0.66)}px;`;

        this._backdrop.show();
        const grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this._backdrop.hide();
            return;
        }
        this._grab = grab;
        this._isOpen = true;
        this._backdrop.grab_key_focus();

        this._render();
        this._popup.remove_all_transitions();
        this._popup.opacity = 0;
        this._popup.scale_x = this._popup.scale_y = 0.97;
        this._popup.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._refresh();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._stopTimer();
        this._stopPlayCheck();
        this._releaseGrab();

        this._popup.remove_all_transitions();
        this._popup.ease({
            opacity: 0,
            scale_x: 0.98,
            scale_y: 0.98,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._isOpen)
                    this._backdrop.hide();
            },
        });
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onBackdropPress(event) {
        const [x, y] = event.get_coords();
        const [px, py] = this._popup.get_transformed_position();
        const [pw, ph] = this._popup.get_transformed_size();
        if (x < px || x > px + pw || y < py || y > py + ph)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const superHeld = (event.get_state() & Clutter.ModifierType.SUPER_MASK) !== 0;
        if (superHeld && (symbol === Clutter.KEY_f || symbol === Clutter.KEY_F)) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (this._gameId &&
            [Clutter.KEY_Escape, Clutter.KEY_BackSpace, Clutter.KEY_Left].includes(symbol)) {
            this._showList();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const adjustment = this._scroll.vadjustment;
        const step = {
            [Clutter.KEY_Down]: 60,
            [Clutter.KEY_Up]: -60,
            [Clutter.KEY_Page_Down]: adjustment.page_size * 0.9,
            [Clutter.KEY_Page_Up]: -adjustment.page_size * 0.9,
        }[symbol];
        if (step) {
            adjustment.value += step;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _refresh() {
        if (this._gameId)
            this._fetchSummary(this._gameId);
        if (this._inFlight)
            return;
        this._inFlight = true;
        this._stopTimer();

        const message = Soup.Message.new('GET', SCOREBOARD_URL);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            this._inFlight = false;
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== 200)
                    throw new Error(`HTTP ${message.get_status()}`);
                this._setData(parseScoreboard(JSON.parse(decoder.decode(bytes.get_data()))));
                this._error = null;
            } catch (e) {
                if (isCancelled(e))
                    return;
                console.warn(`NFL Scores: refresh failed: ${e.message}`);
                this._error = 'Couldn’t reach ESPN';
            }

            if (this._isOpen) {
                this._render();
                this._scheduleRefresh();
            }
        });
    }

    _fetchSummary(id) {
        if (this._summaryInFlight)
            return;
        this._summaryInFlight = true;

        const message = Soup.Message.new('GET', summaryUrl(id));
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            this._summaryInFlight = false;
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== 200)
                    throw new Error(`HTTP ${message.get_status()}`);
                this._summaries.delete(id);
                const json = JSON.parse(decoder.decode(bytes.get_data()));
                const summary = parseSummary(json);
                summary.gamecast = parseGamecast(json);
                this._summaries.set(id, summary);
                if (this._summaries.size > SUMMARY_CACHE_SIZE)
                    this._summaries.delete(this._summaries.keys().next().value);
                this._summaryError = null;
            } catch (e) {
                if (isCancelled(e))
                    return;
                console.warn(`NFL Scores: game ${id} failed: ${e.message}`);
                this._summaryError = 'Couldn’t load game details';
            }

            if (this._isOpen && this._gameId === id)
                this._render();
        });
    }

    _showGame(id) {
        this._listScroll = this._scroll.vadjustment.value;
        this._gameId = id;
        this._summaryError = null;
        this._renderAnimated(0, 1);
        this._fetchSummary(id);
        this._updatePlayCheck(this._data?.games.find(g => g.id === id));
    }

    _showList() {
        this._gameId = null;
        this._stopPlayCheck();
        this._renderAnimated(this._listScroll, -1);
    }

    _renderAnimated(scroll, direction) {
        this._render();
        this._restoreScroll(scroll);
        this._body.remove_all_transitions();
        this._body.opacity = 0;
        this._body.translation_x = 18 * direction;
        this._body.ease({
            opacity: 255,
            translation_x: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // New content has not been allocated yet, so the adjustment may still
    // carry the old height. Re-apply once the real height arrives.
    _restoreScroll(value) {
        const adjustment = this._scroll.vadjustment;
        adjustment.value = value;
        if (this._scrollChangedId)
            adjustment.disconnect(this._scrollChangedId);
        this._scrollChangedId = adjustment.connect('changed', () => {
            adjustment.disconnect(this._scrollChangedId);
            this._scrollChangedId = null;
            adjustment.value = value;
        });
    }

    _setData(data) {
        const now = Date.now();
        for (const game of data.games) {
            for (const team of [game.away, game.home]) {
                const key = `${game.id}:${team.id}`;
                const previous = this._scores.get(key);
                if (game.state === 'in' && previous !== undefined && previous !== team.score)
                    this._flashUntil.set(key, now + SCORE_FLASH_MS);
                this._scores.set(key, team.score);
            }
        }
        this._data = data;
        this._updatedAt = now;
    }

    _scheduleRefresh() {
        const live = this._data?.games.some(g => g.state === 'in');
        const open = this._gameId && this._data?.games.find(g => g.id === this._gameId);
        let seconds = live ? LIVE_REFRESH_SECONDS : IDLE_REFRESH_SECONDS;
        if (open?.state === 'in' && this._tabFor(open) === 'gamecast')
            seconds = this._fieldPending ? PENDING_REFRESH_SECONDS : GAMECAST_REFRESH_SECONDS;
        this._updatePlayCheck(open);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._timerId = null;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Poll the cheap play count only while a live game's gamecast is showing.
    _updatePlayCheck(game) {
        const watching = this._isOpen && game?.state === 'in' && this._gameId === game.id &&
            this._tabFor(game) === 'gamecast';
        if (!watching) {
            this._stopPlayCheck();
            return;
        }
        if (this._playCheckId)
            return;
        this._playCheckId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PLAY_CHECK_SECONDS, () => {
            this._checkForNewPlay();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPlayCheck() {
        if (this._playCheckId) {
            GLib.source_remove(this._playCheckId);
            this._playCheckId = null;
        }
    }

    _checkForNewPlay() {
        const id = this._gameId;
        if (!id || this._playCheckInFlight)
            return;
        this._playCheckInFlight = true;

        const message = Soup.Message.new('GET', playCountUrl(id));
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            this._playCheckInFlight = false;
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== 200)
                    return;
                const count = JSON.parse(decoder.decode(bytes.get_data())).count;
                const previous = this._playCounts.get(id);
                this._playCounts.set(id, count);
                if (previous !== undefined && count !== previous && this._isOpen && this._gameId === id)
                    this._refresh();
            } catch (e) {
                if (!isCancelled(e))
                    console.warn(`NFL Scores: play check failed: ${e.message}`);
            }
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    // Logo downloads finish in bursts; redraw once per burst.
    _queueRender() {
        if (this._renderId || !this._isOpen)
            return;
        this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderId = null;
            if (this._isOpen)
                this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        const data = this._data;
        const games = data?.games ?? [];
        const live = games.filter(g => g.state === 'in');

        const subtitle = [data?.week ? `Week ${data.week}` : null, data?.seasonType]
            .filter(Boolean).join(' · ');
        this._subtitle.text = subtitle || 'Scoreboard';
        this._livePill.visible = live.length > 0;
        this._liveCount.text = `${live.length} live`;
        this._updated.text = this._error ??
            (this._updatedAt ? `Updated ${GLib.DateTime.new_now_local().format('%-l:%M %p')}` : 'Loading…');
        this._updated.remove_style_class_name('error');
        if (this._error)
            this._updated.add_style_class_name('error');

        const scrollValue = this._scroll.vadjustment.value;
        // The field survives rebuilds so a refresh never cuts off a play animation.
        this._field?.get_parent()?.remove_child(this._field);
        this._body.destroy_all_children();

        if (!data) {
            this._body.add_child(new St.Label({
                text: this._error ? 'Scores will appear once ESPN is reachable.' : 'Loading scores…',
                style_class: 'nfl-empty',
            }));
            return;
        }
        if (games.length === 0) {
            this._body.add_child(new St.Label({text: 'No games this week', style_class: 'nfl-empty'}));
            return;
        }

        const game = this._gameId && games.find(g => g.id === this._gameId);
        if (game) {
            this._renderGame(game, this._summaries.get(game.id));
            this._scroll.vadjustment.value = scrollValue;
            return;
        }
        this._gameId = null;

        this._addSection('Live', live);
        this._addSection('Upcoming', games.filter(g => g.state === 'pre'));
        this._addSection('Final', games.filter(g => g.state === 'post'));

        this._scroll.vadjustment.value = scrollValue;
    }

    _addSection(title, games) {
        if (games.length === 0)
            return;

        this._body.add_child(new St.Label({text: title.toUpperCase(), style_class: 'nfl-section-title'}));
        for (let i = 0; i < games.length; i += 2) {
            // Homogeneous rows keep both columns equal and let the cards
            // shrink to leave room for the scrollbar.
            const row = new St.BoxLayout({style_class: 'nfl-grid-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            for (const game of games.slice(i, i + 2))
                row.add_child(this._buildGame(game));
            if (games.length - i === 1)
                row.add_child(new St.Widget({x_expand: true}));
            this._body.add_child(row);
        }
    }

    _buildGame(game) {
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const button = new St.Button({
            style_class: `nfl-game ${game.state}`,
            x_expand: true,
            child: content,
            can_focus: true,
        });
        button.connect('clicked', () => this._showGame(game.id));

        const awayScore = Number(game.away.score);
        const homeScore = Number(game.home.score);
        for (const team of [game.away, game.home]) {
            const other = team === game.away ? homeScore : awayScore;
            let emphasis = '';
            if (game.state === 'post' && (game.away.winner || game.home.winner))
                emphasis = team.winner ? '' : 'lost';
            else if (game.state === 'in' && Number(team.score) < other)
                emphasis = 'trailing';
            content.add_child(this._buildTeamRow(game, team, emphasis));
        }

        content.add_child(this._buildStatus(game));
        return button;
    }

    _buildStatus(game) {
        const status = new St.BoxLayout({style_class: 'nfl-status'});
        const addLabel = (text, styleClass, expand = false) => {
            const label = new St.Label({
                text,
                style_class: styleClass,
                x_expand: expand,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = expand ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
            status.add_child(label);
        };

        if (game.state === 'in') {
            status.add_child(new St.Widget({
                style_class: 'nfl-live-dot',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            addLabel(game.detail, 'nfl-status-clock');
            addLabel(game.downDistance ?? '', 'nfl-status-text', true);
            if (game.redZone)
                addLabel('RED ZONE', 'nfl-redzone-tag');
        } else if (game.state === 'pre') {
            addLabel(game.scheduled && game.kickoff ? formatKickoff(game.kickoff) : game.detail,
                'nfl-status-clock');
            addLabel(game.broadcast ?? '', 'nfl-status-text', true);
        } else {
            addLabel(game.detail, 'nfl-status-clock', true);
        }
        return status;
    }

    _buildTeamRow(game, team, emphasis) {
        const row = new St.BoxLayout({style_class: `nfl-team-row ${emphasis}`.trim()});

        const logo = this._logos.lookup(team.abbr);
        if (logo) {
            row.add_child(new St.Icon({gicon: logo, icon_size: 26, style_class: 'nfl-logo'}));
        } else {
            row.add_child(new St.Label({
                text: team.abbr,
                style_class: 'nfl-logo-fallback',
                style: `background-color: #${team.color};`,
            }));
        }

        const name = new St.Label({
            text: team.name,
            style_class: 'nfl-team-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(name);

        // Possession sits beside the team it belongs to, not beside the score.
        if (team.possession) {
            row.add_child(new St.Widget({
                style_class: 'nfl-possession',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        if (team.record) {
            row.add_child(new St.Label({
                text: team.record,
                style_class: 'nfl-team-record',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.add_child(new St.Widget({x_expand: true}));

        if (game.state !== 'pre') {
            const flashing = (this._flashUntil.get(`${game.id}:${team.id}`) ?? 0) > Date.now();
            row.add_child(new St.Label({
                text: team.score,
                style_class: `nfl-score${flashing ? ' scored' : ''}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        return row;
    }

    // ----- Gamecast tab -----

    _renderGamecast(game, summary) {
        const gamecast = summary.gamecast;
        const teams = {away: game.away, home: game.home};

        const field = this._fieldFor(game);
        field.setHomeLogo(this._logos.path(game.home.abbr));
        const {state, lastPlay} = fieldState(game, gamecast);
        this._fieldPending = state.pending;
        this._showFieldState(game, gamecast, field, state, lastPlay);
        this._body.add_child(field);
        this._body.add_child(this._buildFieldLegend(state));

        this._body.add_child(this._buildPlays(game, gamecast));

        if (gamecast.winProbability.length > 1) {
            const card = this._detailCard(null);
            const title = new St.BoxLayout();
            title.add_child(new St.Label({text: 'WIN PROBABILITY', style_class: 'nfl-card-title', x_expand: true}));
            const home = gamecast.winProbability.at(-1).home * 100;
            const leader = home >= 50 ? game.home : game.away;
            title.add_child(new St.Label({
                text: `${leader.abbr} ${Math.round(Math.max(home, 100 - home))}%`,
                style_class: 'nfl-card-title-value',
            }));
            card.add_child(title);
            card.add_child(new WinProbabilityChart({
                width: FULL_BAR_WIDTH,
                height: WIN_PROBABILITY_HEIGHT,
                away: game.away,
                home: game.home,
                points: gamecast.winProbability,
            }));
            this._body.add_child(card);
        }

        if (gamecast.drives.length) {
            // Flush card so the chart shares the field's yard scale and lines up.
            const card = this._detailCard('Drives');
            card.add_style_class_name('flush');
            card.add_child(new DriveChart({
                width: CONTENT_WIDTH - 2,
                away: teams.away,
                home: teams.home,
                drives: gamecast.drives,
            }));
            this._body.add_child(card);
        }
    }

    _fieldFor(game) {
        if (this._field && this._fieldGameId === game.id)
            return this._field;
        this._field?.destroy();
        this._field = new FieldView({
            width: CONTENT_WIDTH,
            height: FIELD_HEIGHT,
            away: game.away,
            home: game.home,
        });
        this._fieldGameId = game.id;
        return this._field;
    }

    // Animate each new play once, from the field as it was last drawn (or, the
    // first time a game is opened, from where that play started).
    _showFieldState(game, gamecast, field, state, lastPlay) {
        const now = Date.now();
        const previous = this._shownPlay.get(game.id);
        // Coming back after a while: the last drawn state may be several plays
        // old, so start from where the newest play began instead.
        const shown = previous && now - previous.at < 60000 ? previous : null;
        this._shownPlay.set(game.id, {playId: lastPlay?.id ?? null, state, at: now});
        if (previous && !shown && previous.playId === lastPlay?.id) {
            field.setState(state);
            return;
        }

        const isNew = lastPlay && shown?.playId !== lastPlay.id;
        if (game.state !== 'in' || !isNew || !Number.isFinite(lastPlay.startYL)) {
            field.setState(state);
            return;
        }

        // A pending field already jumped to the scoreboard's spot, so replay
        // the play from its own start.
        const from = shown?.state && Number.isFinite(shown.state.ballYL) && !shown.state.pending
            ? shown.state
            : stateBeforePlay(game, gamecast, lastPlay);
        field.playTransition(from, state, lastPlay, playEvent(lastPlay));
        // Only plays that arrive while watching get highlighted in the list.
        if (shown)
            this._freshPlay.set(game.id, {id: lastPlay.id, until: now + FRESH_PLAY_MS});
    }

    _buildFieldLegend(state) {
        const legend = new St.BoxLayout({style_class: 'nfl-legend'});
        const item = (swatchClass, text) => {
            const box = new St.BoxLayout({style_class: 'nfl-legend-item'});
            box.add_child(new St.Widget({style_class: `nfl-legend-swatch ${swatchClass}`, y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            legend.add_child(box);
        };
        if (Number.isFinite(state.ballYL)) {
            item('scrimmage', 'Line of scrimmage');
            if (state.down)
                item('first-down', 'First down');
        }
        if (state.drive) {
            item('dot gain', 'Gain');
            item('dot loss', 'Loss');
            item('dot penalty', 'Penalty');
        }
        return legend;
    }

    _buildPlays(game, gamecast) {
        const card = this._detailCard('Plays');
        const drives = [...gamecast.drives].reverse();
        if (drives.length === 0) {
            card.add_child(new St.Label({text: 'No plays yet', style_class: 'nfl-card-caption'}));
            return card;
        }

        drives.forEach((drive, index) => {
            // The newest two drives start open; clicks override per drive.
            const open = this._openDrives.get(drive.id) ?? index < 2;
            const team = drive.teamId === String(game.home.id) ? game.home : game.away;

            const header = new St.BoxLayout({style_class: 'nfl-drive-header', x_expand: true});
            header.add_child(this._logo(team, 18));
            header.add_child(new St.Label({text: team.name, style_class: 'nfl-drive-team', y_align: Clutter.ActorAlign.CENTER}));
            const result = drive.current ? 'NOW' : drive.resultShort;
            if (result) {
                const good = ['TD', 'FG'].includes(result);
                const bad = ['INT', 'FUM', 'DOWNS', 'MISS', 'SAF', 'BLK'].includes(result);
                const chip = new St.Label({
                    text: result,
                    style_class: `nfl-drive-result${drive.current ? ' now' : good ? ' good' : bad ? ' bad' : ''}`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                chip.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                header.add_child(chip);
            }
            const description = new St.Label({
                text: /^0 plays/.test(drive.description) ? '' : drive.description,
                style_class: 'nfl-drive-description',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            description.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            header.add_child(description);
            header.add_child(new St.Label({text: open ? '▾' : '▸', style_class: 'nfl-drive-chevron', y_align: Clutter.ActorAlign.CENTER}));

            const button = new St.Button({style_class: 'nfl-drive-button', child: header, x_expand: true, can_focus: true});
            button.connect('clicked', () => {
                this._openDrives.set(drive.id, !open);
                this._render();
            });
            card.add_child(button);

            if (open) {
                const fresh = this._freshPlay.get(game.id);
                for (const play of [...drive.plays].reverse())
                    card.add_child(this._buildPlayRow(play, fresh?.id === play.id && fresh.until > Date.now()));
            }
        });
        return card;
    }

    _buildPlayRow(play, fresh) {
        const row = new St.BoxLayout({style_class: `nfl-play-row ${play.kind}${fresh ? ' fresh' : ''}`});

        const left = new St.BoxLayout({style_class: 'nfl-play-left', orientation: Clutter.Orientation.VERTICAL});
        left.add_child(new St.Label({text: play.downDistance ?? '', style_class: 'nfl-play-down'}));
        const period = play.period ? (play.period > 4 ? 'OT' : `Q${play.period}`) : '';
        left.add_child(new St.Label({text: [period, play.clock].filter(Boolean).join(' '), style_class: 'nfl-play-clock'}));
        row.add_child(left);

        const middle = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        middle.add_child(new St.Label({text: kindLabel(play.kind), style_class: `nfl-play-tag ${play.kind}`}));
        middle.add_child(this._wrapLabel(play.text, 'nfl-play-text'));
        row.add_child(middle);

        const showYards = play.yards !== null && play.yards !== 0 &&
            !['kick', 'score', 'other'].includes(play.kind);
        row.add_child(new St.Label({
            text: showYards ? `${play.yards > 0 ? '+' : '−'}${Math.abs(play.yards)}` : '',
            style_class: `nfl-play-yards ${play.yards > 0 ? 'gain' : 'loss'}`,
            y_align: Clutter.ActorAlign.START,
        }));
        return row;
    }

    // ----- Game detail -----

    _tabFor(game) {
        if (game.state === 'pre')
            return 'box';
        return this._tabs.get(game.id) ?? 'gamecast';
    }

    _renderGame(game, summary) {
        this._body.add_child(this._buildDetailNav(game));
        this._body.add_child(this._buildHero(game));

        if (!summary) {
            this._body.add_child(new St.Label({
                text: this._summaryError ?? 'Loading game details…',
                style_class: 'nfl-empty',
            }));
            return;
        }

        if (this._tabFor(game) === 'gamecast')
            this._renderGamecast(game, summary);
        else
            this._renderBoxScore(game, summary);
    }

    _renderBoxScore(game, summary) {
        const teams = {away: game.away, home: game.home};
        if (game.state !== 'pre')
            this._body.add_child(this._buildLinescore(teams, summary.linescores));
        if (game.state === 'pre') {
            if (summary.probability)
                this._body.add_child(this._buildProbability(teams, summary.probability));
            this._addIfPresent(this._buildMatchup(teams, summary));
        }

        if (game.state !== 'pre') {
            const row = this._halfRow();
            row.add_child(this._buildScoring(game, summary.scoring));
            row.add_child(summary.stats.length
                ? this._buildStats(teams, summary.stats)
                : new St.Widget({x_expand: true}));
            this._body.add_child(row);
        }

        if (summary.leaders.length)
            this._body.add_child(this._buildLeaders(teams, summary));
        if (summary.where)
            this._body.add_child(new St.Label({text: summary.where, style_class: 'nfl-where'}));
    }

    _addIfPresent(actor) {
        if (actor)
            this._body.add_child(actor);
    }

    _halfRow() {
        const row = new St.BoxLayout({style_class: 'nfl-grid-row', x_expand: true});
        row.layout_manager.homogeneous = true;
        return row;
    }

    _detailCard(title) {
        const card = new St.BoxLayout({
            style_class: 'nfl-detail-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        if (title)
            card.add_child(new St.Label({text: title.toUpperCase(), style_class: 'nfl-card-title'}));
        return card;
    }

    _logo(team, size) {
        const gicon = this._logos.lookup(team.abbr);
        if (gicon)
            return new St.Icon({gicon, icon_size: size, y_align: Clutter.ActorAlign.CENTER});
        return new St.Label({
            text: team.abbr,
            style_class: 'nfl-logo-fallback',
            style: `background-color: #${team.color}; width: ${size}px; height: ${size}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _wrapLabel(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _buildDetailNav(game) {
        const nav = new St.BoxLayout({style_class: 'nfl-detail-nav'});
        const back = new St.Button({
            style_class: 'nfl-nav-button',
            label: '‹  All games',
            can_focus: true,
        });
        back.connect('clicked', () => this._showList());
        nav.add_child(back);
        nav.add_child(new St.Widget({x_expand: true}));

        if (game.state !== 'pre') {
            const tabs = new St.BoxLayout({style_class: 'nfl-tabs', y_align: Clutter.ActorAlign.CENTER});
            for (const [key, label] of [['gamecast', 'Gamecast'], ['box', 'Box score']]) {
                const tab = new St.Button({style_class: 'nfl-tab', label, can_focus: true});
                if (this._tabFor(game) === key)
                    tab.add_style_pseudo_class('checked');
                tab.connect('clicked', () => {
                    if (this._tabFor(game) === key)
                        return;
                    this._tabs.set(game.id, key);
                    this._render();
                    this._restoreScroll(0);
                    if (this._isOpen) {
                        this._stopTimer();
                        this._scheduleRefresh();
                    }
                });
                tabs.add_child(tab);
            }
            nav.add_child(tabs);
        }
        nav.add_child(new St.Widget({x_expand: true}));

        if (game.link) {
            const gamecast = new St.Button({
                style_class: 'nfl-nav-button',
                label: 'ESPN  ↗',
                can_focus: true,
            });
            gamecast.connect('clicked', () => {
                this.close();
                try {
                    Gio.AppInfo.launch_default_for_uri(game.link, null);
                } catch (e) {
                    console.warn(`NFL Scores: could not open ${game.link}: ${e.message}`);
                }
            });
            nav.add_child(gamecast);
        }
        return nav;
    }

    _buildHero(game) {
        const hero = new St.BoxLayout({style_class: `nfl-hero ${game.state}`});
        const away = Number(game.away.score);
        const home = Number(game.home.score);

        const emphasis = (team, mine, theirs) => {
            if (game.state === 'post' && (game.away.winner || game.home.winner))
                return team.winner ? '' : 'lost';
            if (game.state === 'in' && mine < theirs)
                return 'trailing';
            return '';
        };

        const side = team => {
            const box = new St.BoxLayout({
                style_class: 'nfl-hero-team',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const logo = this._logo(team, 52);
            logo.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(logo);

            const nameRow = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'nfl-hero-name-row'});
            nameRow.add_child(new St.Label({text: team.name, style_class: 'nfl-hero-name'}));
            if (team.possession) {
                nameRow.add_child(new St.Widget({
                    style_class: 'nfl-possession',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            box.add_child(nameRow);
            if (team.record) {
                box.add_child(new St.Label({
                    text: team.record,
                    style_class: 'nfl-hero-record',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
            return box;
        };

        const score = (team, mine, theirs) => {
            const scored = (this._flashUntil.get(`${game.id}:${team.id}`) ?? 0) > Date.now();
            return new St.Label({
                text: game.state === 'pre' ? '' : team.score,
                style_class: `nfl-hero-score ${emphasis(team, mine, theirs)}${scored ? ' scored' : ''}`.trim(),
                y_align: Clutter.ActorAlign.CENTER,
            });
        };

        const center = new St.BoxLayout({
            style_class: 'nfl-hero-center',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const statusRow = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'nfl-hero-status-row'});
        if (game.state === 'in') {
            statusRow.add_child(new St.Widget({
                style_class: 'nfl-live-dot',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const primary = game.scheduled && game.kickoff ? formatKickoff(game.kickoff) : game.detail;
        statusRow.add_child(new St.Label({text: primary, style_class: 'nfl-hero-status'}));
        center.add_child(statusRow);

        const secondary = game.state === 'in' ? game.downDistance : game.broadcast;
        if (secondary) {
            center.add_child(new St.Label({
                text: secondary,
                style_class: 'nfl-hero-sub',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (game.redZone) {
            center.add_child(new St.Label({
                text: 'RED ZONE',
                style_class: 'nfl-redzone-tag',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        hero.add_child(side(game.away));
        hero.add_child(score(game.away, away, home));
        hero.add_child(center);
        hero.add_child(score(game.home, home, away));
        hero.add_child(side(game.home));
        return hero;
    }

    _buildLinescore(teams, linescores) {
        const card = this._detailCard(null);
        card.add_style_class_name('nfl-linescore');
        const periods = Math.max(4, linescores.away.length, linescores.home.length);
        const heading = index => (index < 4 ? String(index + 1) : index === 4 ? 'OT' : `OT${index - 3}`);

        const makeRow = (lead, cells, total, rowClass) => {
            const row = new St.BoxLayout({style_class: `nfl-ls-row ${rowClass}`});
            row.add_child(lead);
            row.add_child(new St.Widget({x_expand: true}));
            for (const text of cells)
                row.add_child(new St.Label({text, style_class: 'nfl-ls-cell'}));
            row.add_child(new St.Label({text: total, style_class: 'nfl-ls-cell total'}));
            return row;
        };

        card.add_child(makeRow(
            new St.Label({text: '', style_class: 'nfl-ls-team'}),
            Array.from({length: periods}, (_, i) => heading(i)),
            'T', 'head'));

        for (const key of ['away', 'home']) {
            const team = teams[key];
            const lead = new St.BoxLayout({style_class: 'nfl-ls-team'});
            lead.add_child(this._logo(team, 18));
            lead.add_child(new St.Label({text: team.abbr, y_align: Clutter.ActorAlign.CENTER}));
            const scores = Array.from({length: periods}, (_, i) => linescores[key][i] ?? '–');
            card.add_child(makeRow(lead, scores, team.score || '0', ''));
        }
        return card;
    }

    _splitBar(awayShare, teams, width, styleClass) {
        const bar = new St.BoxLayout({style_class: styleClass, width});
        const awayWidth = Math.round(width * Math.min(1, Math.max(0, awayShare)));
        bar.add_child(new St.Widget({
            style_class: 'nfl-split-away',
            style: `background-color: #${teams.away.color};`,
            width: awayWidth,
        }));
        bar.add_child(new St.Widget({
            style_class: 'nfl-split-home',
            style: `background-color: #${teams.home.color};`,
            width: width - awayWidth,
        }));
        return bar;
    }

    _buildProbability(teams, probability) {
        const card = this._detailCard(null);
        const home = Math.min(100, Math.max(0, probability.home));
        const away = 100 - home;

        const labels = new St.BoxLayout({style_class: 'nfl-prob-labels'});
        labels.add_child(new St.Label({text: `${teams.away.abbr}  ${Math.round(away)}%`, style_class: 'nfl-prob-value'}));
        labels.add_child(new St.Label({
            text: probability.label,
            style_class: 'nfl-card-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        labels.add_child(new St.Label({text: `${Math.round(home)}%  ${teams.home.abbr}`, style_class: 'nfl-prob-value'}));
        card.add_child(labels);
        card.add_child(this._splitBar(away / 100, teams, FULL_BAR_WIDTH, 'nfl-prob-bar'));
        return card;
    }

    _buildMatchup(teams, summary) {
        const hasForm = summary.lastFive.away.length || summary.lastFive.home.length;
        if (!summary.odds && !hasForm)
            return null;

        const card = this._detailCard('Matchup');
        if (summary.odds) {
            const row = new St.BoxLayout({style_class: 'nfl-matchup-row'});
            row.add_child(new St.Label({text: 'Line', style_class: 'nfl-matchup-label'}));
            row.add_child(new St.Label({text: summary.odds, style_class: 'nfl-matchup-value'}));
            card.add_child(row);
        }
        for (const key of hasForm ? ['away', 'home'] : []) {
            const row = new St.BoxLayout({style_class: 'nfl-matchup-row'});
            const lead = new St.BoxLayout({style_class: 'nfl-matchup-label'});
            lead.add_child(this._logo(teams[key], 18));
            lead.add_child(new St.Label({text: 'Last 5', y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(lead);
            for (const result of summary.lastFive[key]) {
                row.add_child(new St.Label({
                    text: result,
                    style_class: `nfl-form-chip ${result === 'W' ? 'win' : result === 'L' ? 'loss' : 'tie'}`,
                }));
            }
            card.add_child(row);
        }
        return card;
    }

    _buildScoring(game, plays) {
        const card = this._detailCard('Scoring');
        if (plays.length === 0) {
            card.add_child(new St.Label({text: 'No points yet', style_class: 'nfl-card-caption'}));
            return card;
        }

        for (const play of plays) {
            const team = [game.away, game.home].find(t => String(t.id) === play.teamId);
            const row = new St.BoxLayout({style_class: 'nfl-scoring-row'});
            if (team) {
                const logo = this._logo(team, 20);
                logo.y_align = Clutter.ActorAlign.START;
                row.add_child(logo);
            }

            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const period = play.period ? (play.period > 4 ? 'OT' : `Q${play.period}`) : '';
            text.add_child(new St.Label({
                text: [period, play.clock, play.type].filter(Boolean).join('  ·  '),
                style_class: 'nfl-scoring-meta',
            }));
            text.add_child(this._wrapLabel(play.text, 'nfl-scoring-text'));
            row.add_child(text);

            row.add_child(new St.Label({
                text: `${play.away}–${play.home}`,
                style_class: 'nfl-scoring-score',
                y_align: Clutter.ActorAlign.START,
            }));
            card.add_child(row);
        }
        return card;
    }

    _buildStats(teams, stats) {
        const card = this._detailCard('Team stats');

        const head = new St.BoxLayout({style_class: 'nfl-stat-head'});
        head.add_child(this._logo(teams.away, 20));
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(this._logo(teams.home, 20));
        card.add_child(head);

        for (const stat of stats) {
            const row = new St.BoxLayout({
                style_class: 'nfl-stat-row',
                orientation: Clutter.Orientation.VERTICAL,
            });
            const values = new St.BoxLayout();
            values.add_child(new St.Label({text: stat.away, style_class: 'nfl-stat-value'}));
            values.add_child(new St.Label({
                text: stat.label,
                style_class: 'nfl-stat-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            values.add_child(new St.Label({text: stat.home, style_class: 'nfl-stat-value'}));
            row.add_child(values);

            const total = stat.awayValue + stat.homeValue;
            row.add_child(this._splitBar(total > 0 ? stat.awayValue / total : 0.5,
                teams, HALF_BAR_WIDTH, 'nfl-stat-bar'));
            card.add_child(row);
        }
        return card;
    }

    _buildLeaders(teams, summary) {
        const card = this._detailCard(summary.leadersAreSeason ? 'Season leaders' : 'Leaders');
        for (const category of summary.leaders) {
            card.add_child(new St.Label({text: category.label, style_class: 'nfl-leader-category'}));
            const row = this._halfRow();
            for (const key of ['away', 'home']) {
                const leader = category[key];
                const cell = new St.BoxLayout({style_class: 'nfl-leader', x_expand: true});
                cell.add_child(this._logo(teams[key], 20));
                const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                text.add_child(new St.Label({text: leader?.name ?? '—', style_class: 'nfl-leader-name'}));
                if (leader?.line) {
                    const line = new St.Label({text: leader.line, style_class: 'nfl-leader-line'});
                    line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                    text.add_child(line);
                }
                cell.add_child(text);
                row.add_child(cell);
            }
            card.add_child(row);
        }
        return card;
    }

    destroy() {
        this._stopTimer();
        if (this._renderId) {
            GLib.source_remove(this._renderId);
            this._renderId = null;
        }
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._stopPlayCheck();
        this._releaseGrab();
        this._isOpen = false;
        this._field?.destroy();
        this._field = null;
        this._cancellable.cancel();
        this._session.abort();
        this._backdrop.destroy();
    }
}
