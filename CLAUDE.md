# CLAUDE.md: the harness for Bench

Bench is a shared 3D prototyping space where a few people put one part
together at once, for fun, not a full CAD tool. `README.md` is the
argument for what good means here. This file is the rules that argument turns
into. `spec/` is the part of it a machine checks. When the three disagree, the
README wins and the other two get fixed.

Bench began as a 2D drafting table and was rebuilt as 3D CAD when its owner
judged the 2D version too thin to be worth using. The four promises carried
over unchanged; everything below that names 3D is new with that rebuild.

## The four promises, and what each one forbids

1. **The numbers are true.**
   - Every length is millimetres and every angle degrees, rounded to 0.001.
     Y is up in the model. There is no other unit anywhere in the model, the
     protocol or an export; pixels exist only in the viewport.
   - Every number of every feature can be typed in the properties panel. A
     feature kind that can only be dragged does not ship.
   - Primitives stand on their origin (the middle of their base) and grow
     upward, so changing a height never pushes a body through what it sits on.
   - Geometry is built in one place, `shared/evaluate.ts`, which both the
     browser and the server run. The STL export is made by the server from the
     stored timeline, never from what a browser shows. STL is Z up: model
     `(x, y, z)` becomes `(x, -z, y)`, a rotation, never a mirror.
   - Features are validated in one place, `shared/model.ts`
     (`validateFeature`, then `checkReferences` for combines). The server runs
     both on everything it accepts; the client running them is a courtesy.

2. **Nobody's work is overwritten without them seeing it.**
   - The server is the only authority on what the design holds. A client's
     state is a view of it, plus edits it has sent and not had answered.
   - Every update and delete carries the version it was made against, and is
     refused if that is not current. Never "fix" a refused edit by dropping the
     version check or retrying with a fresh version; that is exactly the silent
     overwrite this app exists to prevent.
   - A feature held by one person cannot be changed, deleted or pulled into a
     combine by another. Holds die with the connection and after two minutes
     of silence.
   - A body that a combine uses cannot be deleted while the combine exists.
     A body can be a combine's tool once, and a used-up tool cannot be a
     target.
   - Every refusal is shown to the person refused, in words, naming who caused
     it where that is known.
   - A design has two links. The edit link (`/d/<id>`) can change it; the
     view link (`/v/<view>`, its own random id) can watch, point, follow and
     export, and every change from it is refused by the server, in words. A
     viewer is never told the edit id, and the public list of designs gives
     out view links only (the example alone is open to edit), so neither can
     be used to get round it. `spec/access` holds this.
   - Undo only undoes your own change, and only if the feature is still what
     you left it as. Otherwise it says why it will not.
   - While disconnected, or while looking back along the timeline, editing is
     off and the page says so. Edits are never queued offline.
   - Hiding a body is a view choice, kept in the browser and never sent.
     Nobody can make a part disappear for someone else.
   - The wind preview is a view choice too: kept in the browser, never sent,
     never changes the design. It is a coarse, uncalibrated simulation, so it
     shows where air goes and never a force, a drag figure or any number
     about the air; its note in the view says so.

3. **You can see the other people.**
   - Every connected person has a name and a colour, shown on their 3D
     cursor, on what they hold (in the viewport, the browser tree and the
     timeline) and in the people list.
   - Bodies being dragged, and what someone is about to place or extrude, are
     visible to others before they let go. Drafts are not persisted.
   - Clicking a person follows their camera until you move your own.
   - Presence traffic (cursor, camera, drafts) is batched by the server, one
     message per client per 50 ms at most, because a full room is the case
     this is designed for.
   - Only news travels. A cursor message carries only what changed (pointer
     to 0.1 mm, camera, drag; nothing when still; a bare pointer at most ten
     times a second), the server forwards only changes and never your own,
     and gives a newcomer everyone's current state once. Your own edit comes
     back as a short `ok` (version, place), not the whole feature; everyone
     else gets the feature. Features travel with default numbers left out
     (`pack`/`unpack` in `shared/protocol.ts`), restored before anything
     checks them. `spec/traffic` holds all of this.

4. **It stays.**
   - A change is written to SQLite before it is broadcast. Never reorder these.
   - A feature's place in the timeline (`seq`) is fixed when it is made. An
     edit never moves it, in memory or on disk.
   - The database lives under `DATA_DIR` (`/data` on Fly, the only volume).

## What not to build

No chat, comments or version branches.

Accounts exist for one job: starting designs and keeping each person's
projects (`docs/adr/0005-accounts.md`, superseding 0004). They must not grow
past it.
- Starting a design takes an account. Joining one never does: the edit link
  lets a guest edit and the view link lets a guest watch, exactly as before.
  An account is never a third kind of access; the link decides what you may
  do, signed in or not.
- An account is an email, a name and a salted scrypt hash of the password
  (`server/auth.ts`, `node:crypto`). A password is never stored, logged or
  sent back. There is no password reset, because Bench sends no email; the
  sign-up page says so.
- A session is a random token in an HttpOnly, SameSite=Lax cookie
  (`bench_session`); the database keeps only its SHA-256. Signing out deletes
  it on the server. A request that changes anything is refused if its Origin
  is another site, and a socket opened from another site is a guest.
- `/projects` is a page of its own, listing the designs an account made and
  the ones it opened, each with the link it was given (an edit link only if it
  held one; an edit link once held is kept). Nobody sees another account's
  list, the example is never in one, and removing a project never touches the
  design.
- A guest's name is still a cookie (`bench_guest`) kept by the browser; the
  server never treats it as a sign-in. The list of projects a browser kept
  before accounts is offered once on `/projects` to add, by its links, and
  then forgotten.
- Sign-in failures are limited per address and email, sign-ups per address;
  a limit hit is a refusal in words. `spec/accounts` holds all of this.

Thumbnails come from `/api/views/<view>`: a design's features by its view
link, never its edit id (`spec/access` holds it).

No edge fillets, constraint solver, assemblies, joints or threads: Bench is
a playground for putting one printable part together, not a CAD tool. These
serve experienced CAD users and make playing harder; the time goes to
building together instead. If a change seems to need one, stop and say so
instead of building it.

A chamfer is therefore a typed number on a box (every edge) or a cylinder
(both rims), like a box's fillet, never an operation on picked edges. Tools
that make things (Duplicate, Mirror, Pattern, Circular, Grid, Hole, and the
ready-made parts in `client/parts.ts`: fasteners, gears, brackets,
countersinks and the rest) only ever write ordinary bodies and combines
through the usual versioned edits; none of them is a new kind of feature the
server has to trust. What a recipe cannot model honestly it says in its
note, never fakes: threads, involute gear teeth.

## Rules for the platform

- **Node 24 runs the TypeScript directly.** Only erasable syntax: no `enum`,
  no `namespace`, no constructor parameter properties. `erasableSyntaxOnly`
  enforces it. Relative imports name the `.ts` file.
- **No native dependencies.** The image is `node:24-alpine` on a 256 MB
  machine. SQLite is `node:sqlite`; geometry is three.js and three-bvh-csg,
  both plain JavaScript, bundled into the client by esbuild and imported
  directly by the server.
- **Everything ships in the image.** No CDN scripts, no remote fonts, no
  remote environment maps; the lighting is generated in the browser.
- **`public/build/` is generated** by `pnpm build`, never edited or committed.
- **Bounded everything.** Messages 32 KB, 400 features per design, 20 drafts
  per cursor message, 120 messages per connection per second. A limit hit is
  answered with a refusal, not a crash.
- **No importing, and the server takes no files.** Bench opens no model
  files (`docs/adr/0006-no-import.md`): a model only one person could see
  does not belong in a tool where everyone sees the same part, and a reader
  for other programs' files would have to run code built from untrusted input. The server has
  no route that takes a file, and a body over the limit is answered 413 and
  the connection closed. Never add importing back by storing or relaying
  models: one large upload would sink a 256 MB machine. Every script runs
  under the strict policy, with no eval and no WebAssembly; `spec/models`
  checks both.
- **The example is made with Bench's own tools.** `/d/example` is a wind
  turbine built from the same recipes as the ribbon (`shared/example.ts`),
  written by the server, through the usual checks, whenever that design is
  empty. It is the one design the wind preview starts on in.
- **`/readme/` renders `README.md` on the server**, so the headings are in the
  HTML before any script runs.
- **Works at phone width.** 390 px, no horizontal page scroll, every command
  reachable (the ribbon scrolls inside itself), orbit with one finger, pan and
  zoom with two. Check it on a real phone before saying it works on one.

## Rules for working

- **`pnpm check` is green before every commit.** It runs against a running
  server: `pnpm build && pnpm start` in one terminal, `pnpm check` in another.
- **A new spec test first catches a deliberate bug.** Break what it forbids,
  watch it fail, put it back. The timeline-order test passed while edits were
  reordering the timeline in memory, because it only read the design back
  after everyone had left and the room had reloaded from disk; it now checks
  the live room too. Green on first run proves nothing.
- **Restarts are checked by restarting.** After any change to `server/db.ts`
  or to the order of writes in `server/room.ts`: build something, kill the
  server process (not Ctrl+C), start it again and open the design.
- **Two browsers, before saying a change to the editor works.** One desktop
  window and one at phone size with touch, as two people, doing the thing the
  change touched. The marker tests it that way.
- **Look at the model, not just the test output.** The first boolean results
  passed every check and drew a fan of stray lines across every cut face,
  because EdgesGeometry draws sliver triangles. Only a screenshot showed it.
- **A class names one kind of thing.** The hold tag and the cursor tag once
  shared a class, so "is anything held?" was true whenever a cursor was on
  screen.
- **Kill the server by its PID, never by image name.** `taskkill /IM node.exe`
  once took down every Node process on the machine to restart this one.
- **Corrections land here or in `spec/`**, not just as a retry.
- **Commit as the work lands, in the order it happened.**
- **Never push or deploy without being asked.**
