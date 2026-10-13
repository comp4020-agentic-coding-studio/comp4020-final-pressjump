# ADR 0002: The stack

Status: accepted. Revisited when Bench went from 2D to 3D; the choice held.

## Context

The course fixes one shared-cpu machine with 256 MB of memory, one volume at
`/data`, and HTTP on `$PORT`. Bench needs a server that is the single
authority on a design (ADR 0001), pushes changes to everyone within a second,
writes to disk before it tells anyone, and builds STL from the same geometry
code the browser draws with.

## Options

- **A framework (Next, SvelteKit) with a hosted database and a realtime
  service.** Fast to start, but the realtime service and the database live
  outside the course setup. They also put a second authority beside the
  server, which ADR 0001 rules out.
- **Server-sent events plus POST.** No WebSocket library is needed, but
  cursors at 20 per second per person become 20 HTTP requests per second per
  person. That is the wrong shape for a room full of people.
- **One Node process: WebSockets (`ws`), `node:sqlite` on the volume, and a
  bundled TypeScript client.**

## Decision

The single Node process. Node 24 runs the server's TypeScript directly, so
there is no build step on the server. `ws` carries every message, and
`node:sqlite` writes synchronously before each broadcast. three.js and
three-bvh-csg are plain JavaScript, so the browser bundles them through
esbuild and the server imports them directly. That is what lets one module,
`shared/evaluate.ts`, both draw the model and export it.

## What it costs

- **One process is the ceiling.** A room is one process's memory, with no
  horizontal scaling; fine for a class, wrong for a product.
- **`node:sqlite` is still marked experimental.** It prints a warning, which is
  silenced in the Dockerfile.
- **Boolean operations run on the server for every STL export.** A design with
  hundreds of combines could be slow on a shared CPU. The 400-feature cap
  bounds it.
- **No framework conventions.** Routing, static files and the CSP are written
  by hand in `server/main.ts`, about 200 lines that a framework would have
  provided.
