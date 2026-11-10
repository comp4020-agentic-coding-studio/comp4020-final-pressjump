# Crit 8 reflection

## 1. What was the breakthrough that moved the work forward?

Writing down what good means before any code existed. I described Bench and
the problem behind it from my own group projects, and had the agent write the
README and CLAUDE.md first, so they are the only two files in the first commit
after the template. That was a slower start, but it meant the four promises
were settled before there was anything to defend: the numbers are true,
nobody's work is overwritten without them seeing it, you can see the other
people, and it stays. Every change after that had to answer to them rather
than to whatever was easiest to build.

The proof came quickly. The server that held the shared sheet and refused
edits made against an old version passed its checks, but using it myself
showed that a part looked reserved whenever anyone's pointer was on screen,
because the hold tag and the cursor tag shared a class. No test had caught it.
I turned it into a rule in CLAUDE.md, that a class names one kind of thing,
so the fix would outlast that one bug.

## 2. What did this work change about who I want to be as a software developer?

I used to start with code and work out what it was for along the way. This
showed me how much faster an agent goes in the wrong direction when nobody has
said what right looks like. I want to be the developer who writes the
argument first and keeps it short enough that both people and agents actually
follow it, and who turns every mistake into a rule rather than just a retry.
