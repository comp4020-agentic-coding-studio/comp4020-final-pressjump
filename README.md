# Bench

Bench is 3D CAD for a few people working on one part at the same time: an
enclosure for a board, a bracket, a jig for the workshop. It is laid out like
the desktop CAD tools people already know (a ribbon of commands, a browser of
bodies, a view cube, a timeline of features), but the model is shared. Open
the link and you are in the same design as everyone else who has it open.
You see their cursors and their names on what they hold, you see a body move
while they drag it, and you can follow someone's view to see what they see.

## How to use it

1. Open the home page and pick a design, or start one.
2. Give yourself a name. Nobody signs up; your browser remembers who you are,
   and a second browser is a second person.
3. Place a box, cylinder, sphere, cone or torus from CREATE, or sketch a
   rectangle, polygon or circle on the ground or on a face and extrude it.
   Select a body to type its exact size, position and rotation.
4. Select one body, then Shift-click others, and Combine to cut, join or
   intersect. Move the cutting body later and the hole moves with it.
5. Click someone's avatar to follow their view. Export STL for printing.

Drag to orbit, right-drag or two fingers to pan, scroll or pinch to zoom.

## What good means here

Bench is good if a small group can design a real part together and trust what
comes out. That breaks into four promises.

**The numbers are true.** Every length is millimetres and every number can be
typed, not only dragged. The STL is built by the server from the stored
timeline with the same code the browser draws with, so the export is the
model, at size.

**Nobody's work is overwritten without them seeing it.** When you select a
body it is yours until you let go, and everyone sees your name on it. An edit
sent from an out-of-date view is refused and explained instead of applied over
newer work. A body that a combine uses cannot be deleted from under it. This
is the centre of the app and the opposite of what most shared canvases do:
they let the last write win quietly, which is fine for sticky notes and wrong
for a hole a bolt has to go through.

**You can see the other people.** Cursors in 3D, names on what people hold,
bodies moving while they are dragged, and following someone's camera.
Co-presence is the point; a shared file that updates is not the same thing.

**It stays.** A change is on disk before anyone else hears about it.

## What it does not do

No accounts, chat, comments or version branches. No fillets on arbitrary
edges, no constraint solver, no assemblies or joints. Each is part of what
makes desktop CAD powerful, and each would take months to do honestly; a
half-working version would break the first promise. Hiding a body is yours
alone and is never shared, so nobody can make a part vanish for someone else.

## What is checked and what is judged

Enforced by `spec/`: two people see each other's changes within a second;
held bodies, stale edits and broken combines are refused with a reason;
impossible geometry is refused; the timeline keeps its order across visits;
the STL has the right volume and size, follows a moved cutter, and leaves out
used-up tools.

Judged, by using it with other people: whether the first five minutes are
easy, whether seeing others helps or distracts, and whether it works on a
phone.

## Sources

- Evan Wallace, "How Figma's multiplayer technology works" (Figma blog, 2019),
  for the server-authoritative model, and why it is simpler than CRDTs when
  there is a server anyway.
- Martin Kleppmann, Adam Wiggins, Peter van Hardenberg and Mark McGranaghan,
  "Local-first software: you own your data, in spite of the cloud" (Ink &
  Switch, 2019), which argues the other side and which Bench deliberately does
  not follow.
- Robin Sloan, "An app can be a home-cooked meal" (2020), for permission to
  build something for a small group instead of a market.
