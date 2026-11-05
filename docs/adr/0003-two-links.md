# ADR 0003 Who may change a design

I wrote this decision record on who may change a design in Bench, my
multiplayer CAD app, after crit 9 when I added sharing. The test file
`spec/access.test.ts` enforces it, and I recorded the rule in `CLAUDE.md` under
the promise that nobody has their work overwritten without seeing it.

## Context

Before this change anyone with the link to a design could change it, and the
home page listed the link of every design. I realised that at the showcase a
room of strangers and a long list would let the first person to open a design
move the holes in a part they never made. Bench has no accounts, as ADR 0004 on
guests explains, which meant I could not decide who may change a design by
checking who someone is.

## Options

For option A I could have left every design open, and the promise about not
overwriting work would still hold because no edit is applied silently over
newer work. I decided that an edit from a stranger is still a real edit and
that being told about it afterwards is not much comfort at a showcase.

For option B I could have used accounts with invitations, which is the usual
answer in most collaborative apps. I ruled it out because it requires sign up,
password reset and a members list, and because it adds a step before the moment
Bench is built around, which is a second person joining.

For option C I could give each design two separate links, where the edit link
at `/d/<id>` can change the design and the view link at `/v/<view>` has its own
random id and can only watch, point, follow and export. Whoever holds the edit
link decides who else gets it, and the server refuses changes from a view link
with a written reason.

## Decision

I chose option C and backed it with three rules that the server enforces.

- The public list of designs only gives out view links, and the example design
  is the one exception because it is there for anyone to try.
- A viewer is never told the edit id in the page, in the welcome message or in
  a thumbnail request.
- The Share button shows both links labelled Can edit and Can view with a copy
  button for each one.

## What it costs

- A link cannot be taken back once it is passed on, so I made the Share dialog
  explain exactly what each link allows before anyone copies it.
- Losing the edit link would leave someone only able to watch their own work,
  so I had the browser keep a list of each project with its links as ADR 0004
  describes.
- Viewers still join the room and show a cursor, which I kept on purpose
  because watching a design being built is part of what Bench is for.

## How I will know if it was wrong

If people at the showcase share the view link when they meant to invite someone
to build, I will know that the labels should change rather than the model.
