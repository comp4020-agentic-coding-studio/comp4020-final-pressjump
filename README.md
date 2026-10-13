# Bench

Bench is a shared drafting table for a handful of people designing one
physical thing together: a laser-cut box, a bracket, a jig for the workshop.
Open the link, pick a sheet, and you are drawing on the same sheet as everyone
else who has it open. You see their cursors, you see what they are drawing
before they let go of it, and when you export, what comes out is the part, in
millimetres, at size.

## How to use it

1. Open the home page and choose a sheet, or make one the size of your
   machine's bed.
2. Give yourself a name. Nobody signs up; your browser remembers who you are,
   and a second browser is a second person.
3. Draw with the tools along the top (V select, L line, R rectangle, C circle,
   D dimension). Select a shape to type its exact numbers.
4. Export SVG or DXF from the sheet's menu. Both are in millimetres.

On a phone, one finger draws or drags and two fingers pan and zoom.

## What good means here

Bench is good if a small group can make a real part with it, together, and
trust what it gives them. That breaks into four promises.

**The numbers are true.** Every length is in millimetres and every one can be
typed, not only dragged. An export is the drawing at size. A whiteboard can be
approximately right; a part that is 0.4 mm out does not fit.

**Nobody's work is overwritten without them seeing it happen.** When you pick a
shape up, it is yours until you put it down, and everyone else sees your name on
it. An edit sent from a view that is out of date (a slow connection, a laptop
waking up) is refused and shown, not applied over the newer work. This is the
centre of the app, and it is the opposite of what most collaborative canvases
do: they let the last write win quietly, which is right for sticky notes and
wrong for a hole that something has to fit through.

**You can see the other people.** Cursors, names, and the shape someone is
halfway through drawing. Co-presence is the point of drawing together; a
shared file that updates is not the same thing.

**It stays.** A shape is written to disk before anyone else is told about it,
so anything you saw appear is still there after a restart.

## What it does not do

No accounts, no chat (you are at the same table or on a call), no comments, no
version history beyond your own undo, no layers, no 3D and no constraint solver.
Each of those is a reasonable feature of a bigger tool and each would make this
one slower to pick up in the first minute, which is the minute a group decides
whether to use it.

## What is checked and what is judged

Enforced by `spec/`: two people see each other's changes within a second; a
held shape refuses edits from anyone else; a stale edit is refused; invalid
geometry is refused; what is drawn survives a fresh connection; exports are in
millimetres and contain what was drawn.

Judged, by using it with other people: whether the first minute is easy,
whether seeing others helps or distracts, and whether it works on a phone.

## Sources

- Evan Wallace, "How Figma's multiplayer technology works" (Figma blog, 2019),
  for the server-authoritative model and why it is simpler than CRDTs when
  there is a server anyway.
- Martin Kleppmann, Adam Wiggins, Peter van Hardenberg and Mark McGranaghan,
  "Local-first software: you own your data, in spite of the cloud" (Ink &
  Switch, 2019), which argues the other side and which Bench deliberately does
  not follow.
- Robin Sloan, "An app can be a home-cooked meal" (2020), for permission to
  build something for a small group instead of a market.
