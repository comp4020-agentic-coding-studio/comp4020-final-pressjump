<p align="center">
  <img src="docs/images/logo.svg" alt="Bench logo" width="120">
</p>

# Bench

Bench is a shared 3D prototyping space where anyone can put a part together for
fun. It is not a full CAD tool, and anyone with a design's link can join in.

![Five people holding one bracket](docs/images/together.webp)

## How to use it

1. Create an account and press **New design**. **Share** sends a friend a link
   to edit or watch.
2. Place a box from **Solid** or a bolt from **Parts**, then select it to type
   its sizes.
3. Use **Export STL** in the **File** menu to download it, or **Simulate** to
   blow air past the example.

![The turbine in the wind preview](docs/images/wind.webp)

## What shaped it

As a software engineering student, I have done CAD work in several engineering
courses, and group projects were always hard because none of our tools let two
people work on one part at once. Even to show a basic idea, someone had to do
serious CAD work alone first, so we each ended up building our own version and
comparing them afterwards. I built Bench because I wanted a place where a team
could rough out a part together and see each other's changes in real time. I
double checked with my tutor that this suited the final assignment instead of a
game, and it turned out to be a great fit, because like a game it only works in
real time.

## What good means here

I decided Bench is good when a small group can play with an idea and still
print a real part, because a part printed the wrong size is no fun. I wrote four
promises to keep it right, and turned each into rules in `CLAUDE.md` and tests
in `spec/` for the AI agent (see `PROCESS.md`).

1. I made sure the numbers can be trusted. Sizes are typed in millimetres, and
   the printed file comes from the saved design.
2. I made sure nobody's work is overwritten without them seeing it. Like Figma,
   one server decides every change (Wallace), but I did not want the last save
   to quietly win. Selecting a part reserves it, and a stale change is refused
   with the name of who got there first
   ([ADR 0001](docs/adr/0001-two-people-one-body.md)). Onshape keeps every
   version instead, which is too much for a student tool, and Eyl and others
   found small reservations rarely block anyone. Naming people works because,
   as Shirky argues, a small group already knows each other.
3. I made the other people visible. Gutwin and Greenberg argue collaborators
   need to know who is there and what they are doing, so pointers and moving
   parts show live.
4. I made sure work stays. Every change is saved before anyone sees it.
   Kleppmann and others argue for editing offline and merging later, but two
   merged changes to one size give a part nobody designed. Like their
   Upwelling, Bench shows a part moving before it lands.

## What it does not do

Sloan's idea of an app as a home cooked meal, and Appleton's case that new tools
let more people cook one, made me build a small playground rather than a CAD
tool for a market. So I left out

- advanced CAD tools like fillets, assemblies and threads, and chat, which would
  make playing harder
- importing models, because Bench is not a CAD tool and a file reader that runs
  generated code would let a crafted file run an attacker's code
  ([ADR 0006](docs/adr/0006-no-import.md))
- needing an account to join a design, which I only ask for to start one
  ([ADR 0005](docs/adr/0005-accounts.md))

## What is checked and what is judged

I wrote tests in `spec/` that act out several people against the running app.

- `numbers.test.ts`, `parts.test.ts` and `tools.test.ts` check that impossible
  sizes are refused and parts come out exact.
- `overwrite.test.ts` and `access.test.ts` check that reserved parts, stale
  changes and view links are refused with a reason.
- `accounts.test.ts` checks that only starting a design needs an account.
- `together.test.ts` and `traffic.test.ts` check that people see each other's
  changes within a second.
- `stays.test.ts` checks that work is there for the next visitor.
- `limits.test.ts`, `models.test.ts` and `invariants.test.ts` check that the
  server survives floods, takes no files and publishes this README.

The rest I judged myself. I checked restarts by killing the server, and used
Bench as two people, one at phone size.

<img src="docs/images/phone.webp" alt="Five people on a phone" width="260">

## Sources

- Evan Wallace,
  [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/), 2019.
- Martin Kleppmann and others,
  [Local-first software](https://www.inkandswitch.com/local-first/), 2019.
- Robin Sloan,
  [An app can be a home-cooked meal](https://www.robinsloan.com/notes/home-cooked-app/), 2020.
- Clay Shirky,
  [Situated Software](http://shirky.com/writings/situated_software.html), 2004.
- Carl Gutwin and Saul Greenberg, A Descriptive Framework of Workspace Awareness
  for Real-Time Groupware, _Computer Supported Cooperative Work_ 11, 2002.
- Martin Eyl, Clemens Reichmann and Klaus Müller-Glaser,
  [Prevent Collaboration Conflicts with Fine Grained Pessimistic Locking](https://www.scitepress.org/Papers/2017/61197),
  MODELSWARD 2017.
- Onshape,
  [Under the Hood: How Collaboration Works](https://www.onshape.com/en/blog/under-the-hood-how-collaboration-works).
- Karissa Rae McKelvey, Martin Kleppmann and others,
  [Upwelling](https://www.inkandswitch.com/upwelling/), Ink & Switch, 2023.
- Maggie Appleton,
  [Home-Cooked Software and Barefoot Developers](https://maggieappleton.com/home-cooked-software), 2024.
