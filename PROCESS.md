# Process overview

Bench is multiplayer 3D CAD: a few people in one design at once, laid out like
Fusion, with the server as the single authority on the model. This is how it
got from the brief to the app, the harness and the checks behind it. It is
rewritten at each crit; this version is for crit 9.

## From the brief to a definition of good

The topic was mine before any code: "a multiplayer CAD software". [YOU: one or
two sentences on why CAD, and why multiplayer CAD in particular; only you can
say this.]

I had the agent write the argument before the app. The first commit after the
template is README.md and CLAUDE.md, with no code
([`af27086`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/af27086)).
That carries a position from my earlier courses into this one: assessment is
the curriculum, so what will be checked gets written down before what is
built. The README breaks "good" into four promises, and everything since has
been held to them:

1. the numbers are true
2. nobody's work is overwritten without them seeing it
3. you can see the other people
4. it stays

## The first version, and throwing most of it away

The first build was a 2D drafting table in millimetres. A server held each
sheet and refused stale edits
([`cc939c8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/cc939c8)).
An SVG editor ran on top of it
([`7463d61`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/7463d61)).
It passed every check. When I ran it and used it, I told the agent it was
"really bad CAD software". I gave it a screenshot of Fusion and asked for a
3D tool laid out like that and usable together.

That is the most important correction in the project, and it shows the limit
of the checks. Twenty-eight green tests said the 2D version kept its promises.
None of them could say it was not worth using. The rebuild kept the four
promises and the server model unchanged and replaced everything around them
([`2c9c82b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2c9c82b),
[`2f05c88`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2f05c88)).
CLAUDE.md now opens by saying so. The promises surviving the rebuild is my
evidence that they were about the right thing.

## The stack, and why

One Node process: WebSockets through `ws`, SQLite through `node:sqlite` on the
`/data` volume, and a TypeScript client bundled by esbuild. The options and
costs are in [ADR 0002](docs/adr/0002-stack.md). Two reasons decided it.
First, ADR 0001 needs one authority, which rules out a hosted realtime service
sitting beside the server. Second, three.js and three-bvh-csg are plain
JavaScript, so the code that draws the model in the browser is the same code
that exports STL on the server (`shared/evaluate.ts`). The first promise is
built into that one module, not hoped for. The cost is a single process with
no way to scale out, which suits a class and not a product.

## The crit 9 decision: two people, one body

Crit 9 asks for one decision about several people at once. I chose what
happens when two people change the same thing, because it is promise 2. The
record is [ADR 0001](docs/adr/0001-two-people-one-body.md). It weighs silent
last-writer-wins (Figma's per-property model), automatic merging (the
local-first argument), branches as in desktop CAD, and what Bench does:
selecting a body holds it, and an edit made against an old version is refused
in words that name who changed it.

The cost is real, and it is what I expect the pod to argue. Someone can be in
your way, and two people cannot edit different numbers of one body at the
same time. The ADR says what would show that I chose wrongly.

The decision is enforced, not only written down. `spec/overwrite.test.ts`
has two people act it out against the running server:

- a held body refuses the other person
- a stale edit is refused and the stored body is unchanged
- a body a combine uses cannot be deleted from under it

## How the work was directed, grounded and corrected

The agent wrote the code. I directed what it was for. The harness is how I
kept it honest: CLAUDE.md for the rules and `spec/` for the checks. Two habits
did most of the work.

**Every test was first made to fail.** CLAUDE.md requires a new test to catch
a deliberate bug before it counts. For the 3D spec the agent broke each rule
in turn: the hold check, the version check, reference checks, cut-as-join,
leaving used-up tools in the export, the STL axis swap, the fillet limit, the
disk write and the drafts broadcast. It confirmed each turned a test red.

One break survived. Edits were moving features to the end of the timeline in
memory, and the order test still passed: it only read the design back after
everyone had left, by which point the room had reloaded the correct order
from disk. The test now checks the live room as well, and CLAUDE.md records
why
([`2f05c88`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2f05c88)).

**Look at the thing, not just the output.** Each editor change was driven in
two Chrome windows, desktop and phone-sized with touch, as two people.
Screenshots caught what no test did:

- A hold check that was true whenever anyone's cursor was on screen, because
  two overlay elements shared a class. Fixed in
  [`c3556d5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/c3556d5),
  and made a rule in
  [`f7fae32`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/f7fae32).
- Lines fanning across every cut face, from sliver triangles in the boolean
  results.
- Boxes that sank into the ground when made taller.

Each is fixed and written into CLAUDE.md. The aim is that the correction
lives in the harness, not in my memory of a retry.

One correction is about the agent's conduct rather than the code. To restart
the server it once killed every Node process on my machine by image name.
CLAUDE.md now says to kill by PID.

## Where it stands

Real-time is built, tested and deployed at
https://comp4020-final-pressjump.fly.dev. The first deploy was also the
Dockerfile's first build, and it worked first time.

I checked the live site, not just the local copy:

- the course's two invariant tests pass against it
- two scripted visitors saw each other's edits in 23 to 29 ms
- a box survived a restart of the Fly machine, which shows the `/data` volume
  is doing its job; the probe was deleted afterwards
- the design page loads at desktop and phone widths with no console errors

The full spec is not run against the live site, because it would leave its
test designs there for the marker to find.

[YOU: anything about the crit 9 session itself, once it has happened: what the
pod argued, and whether it changed the ADR.]
