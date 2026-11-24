# Slicefall

A browser port of the gameplay from [Not Tetris 2](https://github.com/Stabyourself/nottetris2)
by Maurice Guégan. Pieces are real rigid bodies: you push and spin them with forces, they
tumble and stack, and a row is sliced straight through the pieces once it holds enough area.

**Play it in the browser: [slicefall.gdainti.com](https://slicefall.gdainti.com/)**

The rules and tuning are carried over from the original Lua source; the presentation (name,
visuals, sound, music) is new. No assets from the original are used.

Not Tetris 2 is itself a physics take on Tetris, which Alexey Pajitnov created in 1984. Tetris is a
trademark of The Tetris Company; neither project is affiliated with or endorsed by it.

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run dev       # the game, with hot reload
npm run server    # in a second terminal: the leaderboard API on :5034
```

Open the URL Vite prints (default http://localhost:5173). Vite forwards `/api` to the server, WebSockets
included; without it the game still plays and shows only the scores kept in the browser, but Online
mode can't open a room.

| Script              | What it does |
| ------------------- | ------------ |
| `npm run build`     | Typecheck and build the game into `dist/` |
| `npm start`         | Serve `dist/` and the API from one process, as in production (http://localhost:5034) |
| `npm test`          | Server tests (`node:test`) |
| `npm run typecheck` | Typecheck the game and the server |

Settings come from `.env` if it exists (see `.env.example`). Nothing secret is needed.

## Leaderboard

After a Cut game you enter a name and the score goes to the server. Names are the only
identity, like an arcade cabinet: the same name is the same player, upper-cased, so `ann` and `ANN`
are one player. Each board lists every player's best score:

- **This week**: since Monday 00:00 UTC
- **All time**

The server keeps the scores in SQLite (`data/slicefall.db`, `/data/slicefall.db` in Docker), using
Node's built-in `node:sqlite`, so it has no npm dependencies at all. Only games the server saw
start can be scored. Each Cut game asks for a session as it begins (`POST /api/games/start`), and at
game over the game is logged against it. The session must be unused and less than a day old, and the game can't report more play than
the server's clock says has passed since the session began (plus 10 s for the start request to
arrive). A score then sends only a name and that session, and gets the numbers of the game the
server logged, once. The server also checks that a game is one the field could produce (points per
row, level and pieces must match the rows, a minimum time per piece) and allows 90 sessions, 60 games and
30 scores per IP per 10 minutes. A fake now takes as long as the game it claims, but the browser
still reports the numbers, so a determined cheat can still post a believable one. Remove those by
hand:

Every finished Cut game is also logged in a `game` table, whether the player submits the score or
skips it (and games that scored nothing, where no name is asked). Each row keeps the score, lines,
level, pieces, cuts, biggest single cut, T-spins and their points, and play time. A game gets the player's name only when they
submit; skipped games have no name and never reach the leaderboard. Each game also carries a
random player id that the browser makes once and keeps in `localStorage`, so one player's games
can be followed whether or not they give a name (and `stats` counts the different ids as
`devices`). It is 32 random hex digits and says nothing about who plays; clearing site data makes a
new one. Submitted scores carry the id too, and a `player_name` table keeps each id and name pair
(not the shared `INCOGNITO`) with how many scores and when it was first and last used, so one person's
names and devices can be found from either side. Logging allows 60 games per IP per 10 minutes.

Every game start is kept too (`game_start`), finished or not, so the leaderboard can show how many
games were started and how many names are on it.

**Stats page.** Set `STATS_PASSWORD` in `.env` and open `/all-stats`: the browser asks for the
password (any user name). One page lists everything below with charts: totals, games started per
day and by hour, devices, time played, score distribution, leaderboards, every name and player id,
the latest games and online rounds. Nothing in the game links to it, it is never cached or
indexed, and 10 wrong passwords from one address lock it out for 10 minutes. Without a password
set it answers 404.

The same numbers from the command line:

```sh
docker exec slicefall node server/admin.ts stats              # games today, this week, all time; then per day; then online rounds
docker exec slicefall node server/admin.ts stats 30           # ... with 30 days in the per-day table
docker exec slicefall node server/admin.ts top                # players who started the most games (all time), with their names
docker exec slicefall node server/admin.ts top 10 7           # ... top 10 over the last 7 days
docker exec slicefall node server/admin.ts games 20           # latest games, "(no name)" when skipped
docker exec slicefall node server/admin.ts matches 20         # latest online Versus rounds
docker exec slicefall node server/admin.ts player 3f9a1c07    # names, games and online rounds of one player id (the first digits will do)
```

```sh
docker exec slicefall node server/admin.ts recent 20          # latest scores with their ids
docker exec slicefall node server/admin.ts name ANN           # every score of one player, and the player ids it came from
docker exec slicefall node server/admin.ts delete 42          # one score
docker exec slicefall node server/admin.ts delete-name ANN    # all of a player's scores and id pairs (their games stay, unnamed)
```

| Endpoint                                  | Returns |
| ----------------------------------------- | ------- |
| `GET /api/leaderboard?mode=cut`           | `{ weekStart, week: [...], allTime: [...] }`, top 10 each |
| `POST /api/games/start`                   | Takes `{ player? }` as a Cut game begins; returns `{ session }`, 32 random hex digits. `player` is the browser's random id, 32 lowercase hex digits |
| `POST /api/games`                         | Takes `{ mode, session, score, lines, level, pieces, cuts, bestCut, durationMs, tSpins?, tSpinPoints?, player? }` at every game over; returns `{ id }`. The session is used up, and must be from the same `player` |
| `POST /api/scores`                        | Takes `{ mode, name, session }` for a logged game that scored; returns the boards plus `weekRank` and `allTimeRank`. The score has that game's numbers, and the game gets the name; with the game's `player`, the name and id are recorded as a pair |
| `GET /healthz`                            | `ok` when the database answers |
| `GET /api/match` (WebSocket)              | Online Versus rooms; see below |

## Attacks (Versus and Online)

With **Attacks: On** in the mode menu (the default), cutting rows sends the other player single
blocks of grey stone. How many, by rows cut at once: 1 → 1, 2 → 2, 3 → 3, 4 or more → 5
(`ATTACK_BLOCKS` in `src/config.ts`, with the other numbers below).

Like garbage in Tetris 99, they go by your pieces, not a clock:

1. **They arrive.** Each block picks one of 10 columns (a free one when it can) and waits at the
   top of it: a red outline blinking slowly, and a faint stripe down the column.
2. **They arm.** When your next piece lands, the waiting blocks arm and blink fast as solid
   blocks. So you always get at least one whole piece of warning.
3. **They drop**, on the next landing that cuts nothing, between your pieces: they fall in from
   above the well at up to 600 px/s and your next piece comes once they are down (well under a
   second, 1.5 s at most). No piece of yours is in the air meanwhile, so they never hit it and
   never appear inside it. At most 6 drop at once; the rest wait for the next landing. A block that
   comes to rest above the top line ends your game, as a piece would.
4. **Cutting cancels them.** A cut first takes away as many waiting blocks as it would send,
   oldest first, and only sends the rest. Nothing drops on a landing that cut rows.

Dropped blocks count toward rows like any other block and are sliced like one. Blocks sent to a
player who has topped out are lost. Sounds: two low beeps when blocks arrive, a thud when they
drop, a chime when a cut cancels some.

## Online Versus

One player picks Online → Create a game and gets a four-character code (no I, L, O, 0 or 1). The
other player picks Online → Join with a code and types it in; the round starts as soon as they join.

The two fields don't affect each other (there are no garbage rows), so there is no shared
simulation. Each browser runs only its own field and sends the other one what it looks like
(`src/online.ts`): 20 times a second, the bodies that moved since the last message, plus the shapes
of new bodies (pieces and cut fragments), the row meter when it changes, the score and the next
piece. That is about 200 bytes a message, some 4 kB/s. The receiving side draws the other field
0.12 s in the past and moves smoothly between messages. Both fields get the same pieces from a seed
the server picks for each round (`seededKinds` in `src/pieces.ts`, integer maths only, so every
browser makes the same sequence), dealt in the piece order of whoever created the game (`pieces`
in `create`, passed to both in each round's `start`; random when a client doesn't say).

The server (`server/match.ts`) only pairs the two connections and passes their messages on. Whoever
tops out first loses: they report their score, the server tells the other player they won
(`won`), and that player's field stops where it is and reports its score too. The server then
sends both scores and who won to both, so they can't disagree. If either player leaves or drops, the room closes and the
other is told.

There is no pause online: both games run at the same time. The Pause button becomes Leave, and
P, Esc or Enter (or a gamepad's Start) only ask whether to leave while the game goes on underneath.
Losing focus doesn't pause either. A background tab gets no animation frames, so there the game runs
on a small Web Worker clock (`src/ticker.ts`) 20 times a second: browsers slow a page's own timers to
about once a second in a background tab, which would make that field jump along for the other
player, but not a worker's. The page's own timer stays as a fallback. Time the page missed altogether (a phone app suspended, the main thread stalled) is made up by
fast-forwarding, up to 30 steps a frame with the player's controls off, so a field never falls
behind the other player's. While catching up the page sends at most about 20 states a second, each
covering more play time.

The WebSocket code (`server/ws.ts`) is written out by hand on `node:http`'s `upgrade` event, so the
server still has no npm dependencies. Limits: a connection must create or join within 10 s; rooms
nobody joins close after 30 minutes; 1000 rooms at once; 30 creates or joins per address per 10
minutes (so codes can't be guessed by brute force); 100 messages a second and 32 kB a message per
connection. Browsers must come from the same host (the `Origin` header is checked). Rooms live in
memory, so a deploy ends the games in progress.

With attacks on (the host's setting, sent with `create` and passed to both in each round's
`start`), a cut sends `{ t: 'attack', n }`. The server passes it on only while both players are
still in the round, for 1 to 5 blocks, and at most one per player per second: a cut blinks for
1.2 s before the next piece can land, so a real client never sends faster. The receiving browser
drops the blocks into its own field, and the blinking markers travel in its state messages, so
the attacker watches them arrive in the other well.

As with the leaderboard, each browser reports its own score, so a modified client could lie. That
is fine between friends, and it's why there is no Versus leaderboard.

Every round the server starts goes in a `match` table when it ends, for play statistics: a random id
for the room (codes are reused, so they can't group rounds), the round number in that room (2 and up
are rematches), both browsers' player ids (sent with create and join; the host created the room, the
guest joined), both final scores with each player's T-spins and their points (as their browser
reports them with the score), the winner, how it ended (`finished` once both topped out,
`host-left` or `guest-left` when someone left or dropped first, with the score of anyone who had
already topped out, or `restart` when the server stopped) and how long the round took by the
server's clock. A room nobody joined, and leaving after a finished round, log nothing. See
`matches` and `stats` in the admin commands above.

## Deployment

One Docker container serves the game and the API. Shipping works the same way as queesti.

Pushing to `master` runs `.github/workflows/deploy.yml`:

1. **check**: typecheck and tests. This also runs on pull requests.
2. **image**: builds the Docker image and pushes `ghcr.io/gdainti/slicefall:latest` and
   `:sha-<commit>`. Pull requests only build it.
3. **deploy**: calls the deployment webhook. The server runs `/opt/docker/slicefall/deploy.sh`,
   which pulls the image, restarts the container and waits until it is healthy.

Actions are pinned to commit SHAs and the base image to a digest; Dependabot
(`.github/dependabot.yml`) opens a PR when either has an update.

The container joins the external `internet-grid` network, so Nginx Proxy Manager reaches it as
`slicefall:5034`. No port is published on the host. It runs as a non-root user with a read-only
filesystem and no Linux capabilities; only `/data` and `/tmp` are writable.

### One-time setup

**GitHub** (repo → Settings → Environments → `production`): under "Deployment branches and tags"
allow only `master`, then add:

| Name             | Type     | Value                                    |
| ---------------- | -------- | ---------------------------------------- |
| `WEBHOOK_URL`    | secret   | URL of the slicefall hook on the server  |
| `WEBHOOK_SECRET` | secret   | token the hook checks                    |
| `APP_URL`        | variable | optional, the game's public URL          |

As environment secrets, only the deploy job on `master` can read them.

**Server:**

```sh
mkdir -p /opt/docker/slicefall && cd /opt/docker/slicefall
# copy compose.yaml and deploy.sh from the repo here (chmod +x deploy.sh)
cp .env.example .env   # or an empty .env: the defaults are fine
docker login ghcr.io   # only if the image is private; a GitHub token with read:packages
```

Point the webhook receiver's slicefall hook at `/opt/docker/slicefall/deploy.sh`. CI does not sync
`compose.yaml` or `deploy.sh`, so copy them to the server again when they change in the repo.

Everything the app keeps is in `/opt/docker/slicefall/data` (`/data` in the container).

**Nginx Proxy Manager:** add a proxy host for your domain → scheme `http`, host `slicefall`, port
`5034`, with **Websockets Support** on (Online mode needs it), a Let's Encrypt certificate and
"Force SSL". The server checks that a WebSocket's `Origin` matches the `Host` header, which Nginx
Proxy Manager passes through unchanged by default.

### Events chat (tg-pigeon)

Like queesti, the server can post short reports to a Telegram chat through
[tg-pigeon](https://github.com/gdainti/tg-pigeon). Set both in the server's `.env` and run `./deploy.sh`:

| Name              | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| `TG_PIGEON_URL`   | `http://tg-pigeon:5040` (tg-pigeon is on `internet-grid`) |
| `TG_PIGEON_TOKEN` | `API_TOKEN` from tg-pigeon's `.env`                       |

With either empty, nothing is posted. Only production posts (`NODE_ENV=production`, set by the
Docker image), so `npm run server` never reaches the real chat. The startup log says which it is.

What gets posted: the container starting (`🚀 slicefall v1.0.0 started`), a Cut, Versus or Online
round starting, a game finishing with its score, the theme changing, and the sound being muted or
unmuted or its volumes changed. Setting changes go out once they have stayed put for 2 seconds, so a
slider drag is one message and a toggle flicked back is none. Players show under their leaderboard
name, or as `guest` and the start of their browser's random id.

The browser sends facts, not text, to `POST /api/events` (`server/events.ts` writes every message
and refuses anything else), limited to 60 reports per IP per 10 minutes. A browser whose stored
leaderboard name is `DEN` (the owner, `OWNER` in `src/events.ts`) sends no reports at all. In Online,
each player's own browser reports, so a round between two other players posts twice.

### Manual deploy and rollback

```sh
cd /opt/docker/slicefall
./deploy.sh                    # latest
./deploy.sh sha-<commit>       # a specific (e.g. previous) build
```

### Local Docker test

```sh
docker build -t slicefall .
docker run --rm -p 5034:5034 -v "$PWD/data:/data" slicefall
```

Then open http://localhost:5034.

### Backups

To take a consistent copy of the database while it is running:

```sh
docker exec slicefall node server/admin.ts backup /data/backup.db
```

### itch.io

The itch.io page doesn't host a copy of the game. [`itch/index.html`](itch/index.html) is a page
with one full-size iframe of https://slicefall.gdainti.com, so itch always shows the deployed
version and the online leaderboard works. The server's `frame-ancestors` lets only itch.io's
domains frame the game.

To make the upload (`index.html` must sit at the root of the zip):

```sh
cd itch && zip -X slicefall-itch.zip index.html
```

On itch.io: Kind of project **HTML**, upload the zip and tick **This file will be played in the
browser**. Embed options: viewport **940 × 640**, **Mobile friendly** and **Fullscreen button** on.
Only re-upload when `itch/index.html` changes; game updates reach itch with each deploy.

The itch page's cover, screenshots and gameplay GIF are in `itch/screenshots/`.

## Modes

| Mode   | Original | Rules |
| ------ | -------- | ----- |
| Cut    | Game A   | Endless. A row is cut out when it holds 8.1 blocks' worth of area. Score = `ceil((n·3)^(avg^10)·20 + n²·40)` for `n` rows at average density `avg`. Level up every 10 rows (+7 px/s fall speed). A T-spin (a joke, since real ones can't happen here) is a falling T turning a full circle, once per piece: +100. |
| Versus | 2P       | Two Cut fields side by side, same piece sequence (mirrored for player 1). Whoever tops out first loses, and the game ends for both (both in the same moment is a draw). With attacks on, cuts drop blocks on the other player (see Attacks). |
| Online | —        | Versus against a player on another device, joined by a code. Each player's own field is full size; the other player's is drawn small beside it. Same pieces for both, not mirrored. Attacks as in Versus. |

The **Pieces** setting on the Game type screen picks how the next piece is chosen, in every mode:

- **7-bag** (the default, as in modern Tetris): all seven pieces go in a bag in a shuffled order and
  are dealt one by one, then a new bag is filled. A kind comes up at most twice in a row (the end
  of one bag and the start of the next) and never waits more than 12 pieces.
- **Random** (as in the original): every piece is picked on its own, so long runs of one kind and
  long droughts can happen.

Online, the setting of whoever creates the game counts.

## Controls

Online mode uses the 1-player keys, gamepad and touch controls.

| Action        | 1 player              | Versus P1 | Versus P2           |
| ------------- | --------------------- | --------- | ------------------- |
| Move          | ← → or A D            | A D       | J L or ← →          |
| Push down     | ↓ or S                | S         | K or ↓              |
| Rotate left   | Z or J                | Q         | U or ,              |
| Rotate right  | X or K                | E         | O or .              |
| Hold          | C, Shift or L         | W         | I, ↑ or /           |

Hold puts the falling piece away and brings the next one; with a piece already held, the two swap.
Once per piece: it can be used again after a piece lands. On touch screens, tap the Hold box.
Hold is off by default: turn it on with Hold on the mode screen (online, the host's setting counts).

Hotkeys (all modes; Online has no pause, so there P / Esc / Enter ask whether to leave):

| Key              | Does |
| ---------------- | ---- |
| P / Esc / Enter  | Pause (or click the Pause button under the next-piece box) |
| P / Esc          | Resume, while paused |
| R                | Restart, while paused |
| O                | Options, while paused |
| Q                | Quit to the mode menu, while paused |
| M                | Mute / unmute all sound |
| F                | Fullscreen |

Gamepads work too (d-pad/stick to move, A/RB rotate right, B/X/LB rotate left, Y holds, Start pauses;
in Versus, pad 1 is player 1 and pad 2 is player 2). Touch devices get on-screen buttons.

Options → Graphics switches between the default look and Retro: four greys, 8×8 pixel-art blocks
with a pattern per piece kind, brick walls round the well, square panels and monospace type.

## How the port maps to the original

| File               | Ported from | What it does |
| ------------------ | ----------- | ------------ |
| `src/config.ts`    | `main.lua` constants | Forces, torque, damping, friction, thresholds, timings. LÖVE's 30 px/m scale is kept. |
| `src/field.ts`     | `gameA.lua`, `gameB.lua`, `gameBmulti.lua` | One playfield: planck.js world, walls, spawning, controls, landing detection, row density, cutting, scoring, levels, fall-out on game over. |
| `src/geometry.ts`  | `refineshape`, `shrinkpolygon`, `largeenough`, `settetrimass` | Polygon clipping, area, Box2D-style mass properties, sliver rejection. |
| `src/pieces.ts`    | `newtetrishapes` | Piece layouts (four 32 px squares each). |
| `src/games.ts`     | — | Single-player, Versus and Online game flow plus the HUD. |
| `src/online.ts`    | — | Online: turns a field into state messages, and draws the other player's field from them. |
| `src/net.ts`       | — | Online: the WebSocket to the server's rooms, and room codes. |
| `src/ticker.ts`    | — | Online: a Web Worker clock that keeps the game going in a background tab. |
| `src/demo.ts`      | — | Self-playing field behind the title screen. |
| `src/audio.ts`     | — | Synthesised sound effects and two original music loops (WebAudio). |
| `src/api.ts`       | — | Calls the leaderboard API. |
| `server/`          | — | Node server: static files, leaderboard API, SQLite (`db.ts`), score checks (`scores.ts`), online rooms (`match.ts`) over a small WebSocket implementation (`ws.ts`), admin script. Runs as TypeScript directly, since Node strips the types. |

Physics uses [planck.js](https://github.com/piqnt/planck.js), a JavaScript rewrite of Box2D,
the same engine LÖVE wraps. The simulation runs at a fixed 60 Hz step so it behaves the same
on any refresh rate.

Settings, your last leaderboard name, a personal top 5 and the random player id sent with each
logged game are stored in the browser's `localStorage`.
