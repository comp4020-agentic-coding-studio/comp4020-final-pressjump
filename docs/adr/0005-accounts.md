# ADR 0005 Accounts for starting designs, links for joining them

This decision record replaces ADR 0004, my record on remembering people in the
browser instead of with accounts. I put the rules in `CLAUDE.md` under what not
to build, and `spec/accounts.test.ts` checks them against the running server.

## Context

ADR 0004 kept each person's name and project list in their browser, so Bench
needed no accounts. In use that meant a person's projects lived on one browser
only: a second device, a cleared browser or a private window lost them, and
the list held edit links that were gone for good once the browser forgot them.
I decided Bench should have accounts, with a projects page of its own at
`/projects` in place of the popup on the home page.

What ADR 0004 protected still matters. Bench is built around a second person
joining from a link without signing up first, and ADR 0003, my record on who
may change a design, decides that by which link you hold.

## Options

For option A I could have required an account for everything, including
opening a shared link. I ruled it out because it puts a form between a link and
the design, which is the moment Bench exists for.

For option B I could have made accounts the way to grant access, with
invitations instead of edit links. I ruled it out because it would replace ADR
0003 with a much larger system and leave two ways to decide the same thing.

For option C I could require an account to start a design and keep projects,
and leave joining exactly as it was: the edit link edits and the view link
watches, for a guest or an account alike.

## Decision

I chose option C. An account is an email, a name and a password kept only as a
salted scrypt hash, made with `node:crypto` so the image still has no native
module. A session is a random token in an HttpOnly cookie, and the database
keeps only its hash. Signing up or in goes to `/projects`, which lists the
designs the account made and the ones it opened, each with the link it was
given. A guest who opens a link is asked for a name as before and can edit or
watch as that link allows, but starting a design sends them to sign up.

## What it costs

- The server now holds personal data: an email and a password hash per
  account. I kept it to those two and a name, and nothing else is stored.
- There is no password reset, because Bench sends no email. The sign-up page
  says so, and a forgotten password means a new account.
- Signing in costs a slow hash, which a 256 MB machine can afford only a few
  at a time, so failed sign-ins and new accounts are limited per minute.
- Lists kept in browsers before this change would be lost, so `/projects`
  offers once to add them to the account by the links the browser held.

## How I will know if it was wrong

If people at the showcase stop at the sign-up page instead of joining a design
they were sent, the line between starting and joining is in the wrong place,
and joining must be made more obvious, never gated.
