# ADR 0004 A guest the browser remembers instead of an account

I wrote this decision record on how Bench, my multiplayer CAD app, remembers
people without accounts just before the final submission. I put the rule in
`CLAUDE.md` under what not to build, and `spec/access.test.ts` checks the one
use the server makes of the name cookie.

## Context

I noticed that a person coming back to Bench could not find their designs
again, because the home page showed every design but did not mark any of them
as theirs. After ADR 0003, my record on who may change a design, the list only
gives out view links, which meant a design someone made could only be found
again if they had kept its edit link. The obvious fix was accounts, but my
README rules them out because Bench is built around a second person joining
from a link without signing up first.

## Options

For option A I could have added proper accounts with sign in, which would work
across devices. I ruled it out because it requires sign up, password reset and
a store of personal data on a 256 MB machine, and because it puts a form
between a link and the design.

For option B I could have kept a record for each guest on the server with a
browser id and a project list. I ruled it out because the server would then
hold a profile of everyone who ever opened a design, which is an account in all
but name.

For option C I could keep the guest profile inside the browser, with the chosen
name in a cookie so the home page can greet the person before any script runs
and the list of opened designs in local storage along with their links.

## Decision

I chose option C because it keeps Bench free of accounts while still feeling
personal to the person using it. The home page now shows a welcome back message
and the latest projects with pictures of them, and a My projects popup lists
the rest without a separate page or a sign in. The server reads the name cookie
only to put the name in the page it sends, after escaping it, and the project
list never leaves the browser.

## What it costs

- Each browser counts as one person, so I made the projects popup explain that
  clearing the browser also clears the list.
- A design renamed by someone else could show an old name, which I handled by
  updating names from the public list whenever the home page refreshes.
- The list holds edit links, which is the same risk as anyone reading the
  history of that browser, so I kept the list in the browser alone and never
  send it anywhere.

## How I will know if it was wrong

If people at the showcase expect their projects on a second device, my next
step would be letting them export the project list as a file of links rather
than adding accounts.
