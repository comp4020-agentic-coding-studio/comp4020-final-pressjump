# Process overview

I built Bench in four stages, and in each the agent made a change, I used it and
told it what was wrong, and anything worth keeping went into `CLAUDE.md` or
`spec/` instead of a retry.

## Getting started

The start was more talking than building, since I wanted the agent to understand
what I was after before it wrote anything. I described the software I had in
mind and the problem behind it from my own group projects, and had the agent
write the README and CLAUDE.md before any code, so they are the only two files
in the first commit after the template
([`af27086`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/af27086)).
This meant a slower start, but it tied every later change to rules I had agreed
with.

## Crit 8, a first version that worked

The weeks before crit 8 were about getting something working, with more than one
person using it at once. I had asked for 3D multi-user CAD, but the agent's
first build was a flat 2D sheet, and I kept it as a first step to prove the
multi-user side worked. The server stored each drawing and refused any edit made
to an out of date copy
([`cc939c8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/cc939c8)),
and tests checked the four promises
([`cd4e161`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/cd4e161)).
Using it myself caught a bug where any pointer on screen made a part look
reserved, which I turned into a rule in CLAUDE.md
([`c3556d5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/c3556d5),
[`f7fae32`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/f7fae32)).
By the end of week 8 I had a working base to build 3D on.

## Crit 9, moving to 3D and deciding who wins

Week 9 was the big one, where Bench started to look like what I had pictured and
I made the decision the rest of it depends on. The server and its checks carried
over, and the agent built the 3D editor on top
([`2c9c82b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2c9c82b),
[`2f05c88`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2f05c88)).
The 2D version had passed all twenty eight checks, yet using it showed a flat
drawing was too limited, which taught me to use the app, not just the tests.

The decision was what happens when two people change the same body
([ADR 0001](docs/adr/0001-two-people-one-body.md)). Rather than letting
whichever edit arrives last quietly win, I used ownership, which I took from my
past game development work, where an object in a player's hand belongs to them
and nobody else can change it. Selecting a body holds it, and a stale edit is
refused naming who got there first. The trade-off is that someone may have to
wait, which beats losing their work.

CLAUDE.md says a test only counts once it has caught a deliberate bug, so the
agent broke each new rule on purpose, and one break survived. The test that the
steps of a design stay in order still passed while they were shuffled, because
it only checked the saved copy, so I had it check the live design too
([`2f05c88`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/2f05c88)).
I then deployed, and on the live site two scripted visitors saw each other's
edits in under 30 ms and a box survived a Fly restart
([`39d08f5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/39d08f5)).
By the end of week 9 Bench was in 3D and live.

## Crit 10, classmates using it

Week 10 was less about building and more about watching, as I got to put Bench
in front of my classmates in my lab and see how they use it. It was eye opening,
as those who had never used CAD struggled, partly because the editor had no
gizmos, the handles you drag to move a part.

That changed what I thought Bench was. I stopped treating it as a full CAD tool
and started treating it as a prototyping space, and changed the README,
CLAUDE.md and home page to match. By the end of week 10, what I saw had become
my list for the agent.

## Week 12 and after, finishing Bench

The last stretch was mostly polish, turning feedback into features and small
fixes so Bench felt good to use rather than just working. My week 12 makeup
session gave me one more round of feedback from my peers to add to that list.

Most of it was for people new to CAD. The agent added move and rotate arrows,
the gizmos my classmates had missed, which can be dragged or given an exact
amount
([`614a5da`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/614a5da)),
and a short first-visit tour that walks new visitors through placing and
changing a part
([`6dd8577`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/6dd8577)).

To show what Bench is capable of, the agent also built a ready-made example
turbine made only from Bench's own tools
([`0f3f76e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/0f3f76e)),
and a wind preview in the **Simulate** tab that shows air flowing past it
([`59dad08`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/59dad08),
[`3c24222`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/3c24222)).
I had CLAUDE.md forbid the preview from showing numbers about the air, since a
made up number would break promise one. Every design also got a view-only link
next to its edit link ([ADR 0003](docs/adr/0003-two-links.md)). I also reworked
the landing page so it invites people in and explains what Bench is, and pointed
the agent at [akkento.com](https://www.akkento.com/) as a reference for its
style, since I liked its UI.

For the small machine, the agent now sends only what has changed, which
`spec/traffic` checks
([`b79812a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/b79812a)),
and reuses the results of cuts and joins, which took the example turbine from
12.7 seconds to under one to build
([`c2ac902`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/c2ac902)).

Two late decisions reversed earlier ones, and both times I changed the harness
first. I had ruled out accounts in ADR 0004, but projects were stuck in one
browser, so I replaced it with [ADR 0005](docs/adr/0005-accounts.md) and a new
rule in CLAUDE.md. I had also added file import
([`ce52281`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-pressjump/commit/ce52281))
but later removed it ([ADR 0006](docs/adr/0006-no-import.md)), keeping the test
that the server takes no files.

By the end, Bench had become something a group can pick up and use together
without knowing CAD.

## The stack and why I chose it

I built Bench with Node, WebSockets and SQLite on a Fly.io volume, with my own
server as the only authority on a design, since holds only work if one place
decides. The trade-off is that everything runs on one small machine.

For 3D I looked at a CAD kernel like OpenCascade, but it is a large WebAssembly
build that is slow to load and hard to run on the server. I picked three.js
because it is plain JavaScript, so the same code draws the model in the browser
and builds the STL on the server, and what someone sees is exactly what prints
([ADR 0002](docs/adr/0002-stack.md)).

For the agent I used Claude Opus 5.5, which I found the strongest model for
design and UI work, which matters for beginners.

## Where it stands

All 118 checks in `spec/` pass against a running server.