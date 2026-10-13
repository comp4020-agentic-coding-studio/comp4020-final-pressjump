# Crit 9 reflection

## 1. What was the breakthrough that moved the work forward?

Deciding that the question was not which edit wins when two people change the
same body, but whether the person whose edit lost finds out. Once I framed it
that way, the choice in ADR 0001 followed from the README: selecting a body
holds it, and an edit made against an old version is refused in words that
name who changed it, instead of being applied silently over newer work. In
CAD a quietly overwritten dimension is a part that does not fit, so silent
last-writer-wins was never an option for Bench even though it is the easiest
to build.

The other turn this week was rejecting my own first version. The 2D drafting
table passed every check, and it was still not worth using, so I had it
rebuilt as 3D CAD. The four promises survived the rebuild unchanged, which
told me they were the right definition of good.

## 2. What did this work change about who I want to be as a software developer?

Green checks told me the 2D version kept its promises, and nothing about
whether anyone would want it. I want to be the developer who opens the thing
and uses it before trusting the test output, and who writes down the cost of
a decision as plainly as the decision itself, so the people who disagree have
something real to argue with.
