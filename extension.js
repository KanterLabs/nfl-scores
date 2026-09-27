import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME Shell caches ES modules for the whole session. Importing the
// scoreboard with the newest module mtime in the URL means `make reload`
// picks up edits without logging out, while unchanged files reuse the cached
// modules. scoreboard.js passes the same version on to the other modules.
const MODULES = ['scoreboard.js', 'games.js', 'field.js', 'draw.js', 'capture.js'];

function scoreboardUrl(dir) {
    const version = Math.max(...MODULES.map(name => dir.get_child(name)
        .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
        .get_modification_date_time().to_unix()));
    return `${dir.get_child('scoreboard.js').get_uri()}?v=${version}`;
}

export default class NflScoresExtension extends Extension {
    async enable() {
        const token = this._token = {};
        const {Scoreboard} = await import(scoreboardUrl(this.dir));
        if (this._token !== token)
            return;

        this._scoreboard = new Scoreboard();
        this._settings = this.getSettings();
        // POPUP mode is left out on purpose: while the scoreboard holds its
        // modal grab it handles Super+F itself, so the key never double-fires.
        Main.wm.addKeybinding(
            'toggle-scoreboard',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._scoreboard.toggle());
    }

    disable() {
        this._token = null;
        if (this._scoreboard) {
            Main.wm.removeKeybinding('toggle-scoreboard');
            this._scoreboard.destroy();
            this._scoreboard = null;
        }
        this._settings = null;
    }
}
