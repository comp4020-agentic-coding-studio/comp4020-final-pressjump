# CLAUDE.md: the harness for Bench

Bench is 3D CAD for a few people on one part at once. `README.md` is the
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
   - Undo only undoes your own change, and only if the feature is still what
     you left it as. Otherwise it says why it will not.
   - While disconnected, or while looking back along the timeline, editing is
     off and the page says so. Edits are never queued offline.
   - Hiding a body is a view choice, kept in the browser and never sent.
     Nobody can make a part disappear for someone else.

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

4. **It stays.**
   - A change is written to SQLite before it is broadcast. Never reorder these.
   - A feature's place in the timeline (`seq`) is fixed when it is made. An
     edit never moves it, in memory or on disk.
   - The database lives under `DATA_DIR` (`/data` on Fly, the only volume).

## What not to build

No accounts, chat, comments or version branches. No edge fillets, constraint
solver, assemblies or joints: each would take far longer than this project has
to do honestly, and a half-working one breaks promise 1. If a change seems to
need one, stop and say so instead of building it.

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
