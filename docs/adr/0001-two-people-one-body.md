# ADR 0001: When two people change the same body at once

Status: accepted, crit 9 (week 10). Enforced by `spec/overwrite.test.ts`;
the rules it implies are in `CLAUDE.md` under promise 2.

## Context

Bench is 3D CAD for a few people on one part at the same time. At the crit,
and at the showcase, several people will have the same design open, and
sooner or later two of them will reach for the same body: one resizing the
plate while another moves the hole through it, or one deleting the cutter
that another just combined.

`README.md` says good means a small group can design a real part together
and trust what comes out. Two of its promises bear directly on this: the
numbers are true, and nobody's work is overwritten without them seeing it. A
part is not a whiteboard. If a hole is 0.4 mm out the bolt does not go in, and
nobody notices until the print comes off the bed.

So the question is not only which edit wins. It is whether the person whose
edit lost finds out.

## Options

**A. Last writer wins, silently.** Every edit is applied in the order the
server receives it. This is what most shared canvases do, and Figma describes
doing it per property: two people setting different properties of one object
both succeed, and two setting the same property end up with whichever arrived
last (Wallace, 2019). Cheapest to build, nothing is ever refused, and
everything feels instant. The cost is that work disappears without anyone
being told, and in CAD the overwritten edit is usually a dimension that
something else was designed around.

**B. Merge automatically (CRDTs or operational transformation).** Each client
keeps its own copy, edits merge, every copy converges. This is the
local-first position (Kleppmann et al., 2019) and the only option here that
works offline. But convergence is not correctness. Merging "width 80" with
"width 60" converges on one of them, which is option A with more machinery;
merging a delete with a move converges on something neither person meant.
It also needs a CRDT for a feature timeline with references between features,
which is a research project, not a crit.

**C. Lock while held, and refuse stale edits (pessimistic plus optimistic).**
Selecting a body takes a hold on it. Everyone sees your name on it, in your
colour, and the server refuses edits to it from anyone else. Separately, every
edit carries the version it was made against, and the server refuses it if
the body has changed since. Both refusals come back in words, naming who.

**D. Branches, as in desktop CAD.** Everyone edits their own version and
merges deliberately. Honest, but it removes the "at the same time" the brief
asks for: you would be working near each other, not together.

## Decision

Option C. Selecting a body holds it. A held body cannot be edited, deleted or
pulled into a combine by anyone else. Every update and delete names the
version it was made against, and a stale one is refused with the current
version sent back. The person refused is told in words who changed what: "Ada
changed Box 1 before your edit arrived", or "Ada is holding Cylinder 2".

Some rules follow from it:

- **Holds expire.** A hold ends when its connection closes, or after two
  minutes with nothing from that person, so someone who walks away from the
  table does not lock the part.
- **Undo checks first.** Undo only undoes your own change, and refuses with a
  reason if someone has changed that body since.
- **Combines protect their bodies.** A body a combine uses cannot be deleted
  while the combine exists.
- **No offline edits.** While disconnected, editing is off. Edits are never
  queued offline to be replayed over whatever happened meanwhile.

## What it costs

- **Someone can be in your way.** If Ada has the plate selected, Bo waits or
  asks her. In a room of people at one table that is a conversation; across a
  slow connection it is friction. The two-minute expiry bounds it but does not
  remove it.
- **Two people cannot edit different numbers of one body together.** Option A
  per property would let Ada set the width while Bo sets the colour. Bench
  refuses Bo. That is stricter than it needs to be for colour, and the price
  of one simple rule.
- **A refused edit is lost.** The refused person sees what they tried and the
  current state, but has to make the edit again. Bench prefers that to keeping
  it and applying it later over something they never saw.
- **No offline work.** Option B's main strength is given up entirely.
- **Every edit waits on the server to be confirmed.** Edits show at once
  locally and are put back if refused, so this mostly shows as the occasional
  shape snapping back, with a reason.

## How we will know if it was wrong

If people at the crit or the showcase spend more time waiting on holds than
modelling, holds are too coarse. The next step would be holding a body's
size and its position separately, not going back to silent overwrites. If
refusals happen often enough to annoy without a hold being involved, the
version check is catching edits it does not need to, and per-property
versions are the fix.

## Sources

- Evan Wallace, "How Figma's multiplayer technology works", Figma blog, 2019.
- Martin Kleppmann, Adam Wiggins, Peter van Hardenberg and Mark McGranaghan,
  "Local-first software: you own your data, in spite of the cloud", Ink &
  Switch, 2019.
