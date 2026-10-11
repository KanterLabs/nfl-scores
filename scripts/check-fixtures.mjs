// Offline parser smoke check used by CI.  It never contacts ESPN.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const positional = [];
let moduleDir = new URL('../', import.meta.url);
for (let i = 0; i < process.argv.slice(2).length; i++) {
    const arg = process.argv[i + 2];
    if (arg === '--module-dir') {
        const value = process.argv[++i + 2];
        if (!value)
            throw new Error('--module-dir requires a directory');
        moduleDir = pathToFileURL(resolve(value) + '/');
    } else if (arg.startsWith('--')) {
        throw new Error(`unknown option: ${arg}`);
    } else {
        positional.push(arg);
    }
}

const root = positional[0]
    ? pathToFileURL(resolve(positional[0]) + '/')
    : new URL('../fixtures/', import.meta.url);
const {parseScoreboard, parseSummary, parseGamecast, fieldState} =
    await import(new URL('games.js', moduleDir));
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

const scoreboard = parseScoreboard(read('scoreboard-offline.json'));
if (scoreboard.games.length !== 1)
    throw new Error(`expected one offline game, got ${scoreboard.games.length}`);
const game = scoreboard.games[0];
if (game.id !== '100' || game.state !== 'in' || game.downDistance !== '2nd & 4')
    throw new Error(`unexpected offline scoreboard parse: ${JSON.stringify(game)}`);

const raw = read('summary-100-game.json');
const summary = parseSummary(raw);
if (summary.awayId !== '1' || summary.homeId !== '2' || summary.stats.length < 2)
    throw new Error(`unexpected offline summary parse: ${JSON.stringify(summary)}`);

const gamecast = parseGamecast(raw);
if (gamecast.drives.length !== 2 || gamecast.drives.flatMap(d => d.plays).length < 3)
    throw new Error(`unexpected offline gamecast parse: ${JSON.stringify(gamecast)}`);
const {state, lastPlay} = fieldState(game, gamecast);
if (state.ballYL !== 44 || state.offenseId !== '2' || lastPlay?.kind !== 'pass')
    throw new Error(`unexpected offline field state: ${JSON.stringify({state, lastPlay})}`);

console.log(`offline fixtures: ${scoreboard.games.length} game, ${gamecast.drives.length} drives, ${gamecast.drives.flatMap(d => d.plays).length} plays`);
