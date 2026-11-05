# ADR 0002 The stack

I wrote this decision record on the stack for Bench, my multiplayer CAD app, at
crit 9 in week 10 and kept the decision to the end. I wrote the rules that
follow from it into `CLAUDE.md` under the rules for the platform.

## Context

The brief gave me one small Fly.io machine in Sydney with a shared CPU and 256
MB of memory, and anything that persists has to be stored on one 1 GB volume at
`/data`. The machine also stops when nobody is using it, which meant I had to
plan for the marker coming back the next day after a restart and still finding
the work both people did.

On top of that I set three needs of my own for Bench.

1. I wanted the server to decide every change, because ADR 0001, my record on
   two people changing the same body, has the server keep the design, refuse
   stale edits and manage the holds.
2. I wanted the exported STL file to match the model exactly, because if the
   browser and the server built geometry with different code the result would
   depend on two implementations agreeing.
3. I wanted it to cope with a full room, because the showcase puts many people
   in one design moving cursors at once on a 256 MB machine.

## Options

For option A I looked at a hosted real time service such as Firebase, Supabase
Realtime or Liveblocks beside a small server. It would have taken the least
code, but the edits would travel through another company and my server would
only see them afterwards, which means it could not refuse a stale edit in time.

For option B I looked at a CRDT library such as Yjs or Automerge, which merges
edits from everyone automatically and works offline. I turned it down because
ADR 0001 shows that merging is wrong for CAD when two widths silently merge
into one, and because I would have needed a CRDT for a timeline whose features
refer to each other.

For option C I looked at a web framework such as Next.js with a Postgres
database, which I already knew well. I turned it down because a second database
service does not fit one machine with one volume, and server rendering adds
little to an app that is mostly one WebGL canvas.

For option D I looked at running on Node with the ws library for WebSockets and
SQLite for storage, using three.js and its CSG library, which cuts and joins
solids, for geometry on both sides and esbuild to bundle the browser code.

## Decision

I chose option D and these are the reasons that decided it for me.

- Node 24 runs my TypeScript directly with type stripping, which means the
  server has no build step and what runs is exactly what is in the repo, and I
  protected that with the `erasableSyntaxOnly` setting.
- SQLite ships with Node, so I had no native module to compile on Alpine, and
  because its writes are synchronous I could make writing to disk before
  broadcasting just the order of two lines.
- I chose WebSockets through `ws` because Bench sends messages both ways at
  once, with edits going up while other people and their cursors come down, and
  polling that often would waste the small machine.
- three.js and its CSG library are plain JavaScript, which means
  `shared/evaluate.ts` can draw the model in the browser and build the STL file
  on the server, so I met the second need with one implementation instead of
  two.
- esbuild bundles the browser code in under a second while the server imports
  the same shared modules without any bundling.

## What it costs

- One process cannot scale out, which I accepted because Bench is built for a
  classroom and a showcase rather than a product.
- Geometry on the server costs CPU on a shared core, so I kept the STL export
  as the only place where the server builds geometry.
- Everything has to be included in the image with no CDN or remote fonts, so I
  load the large STEP reader only in the background worker that uses it.
- The CSG library drew stray edge lines on cut faces, which I caught by
  checking screenshots and fixed before I deployed it.

## How I will know if it was wrong

If the showcase room makes the machine run out of memory or cursors lag past
the 50 ms batching, my next step would be moving cursor updates out of the edit
path rather than switching to a hosted service.
