# ADR 0006 No importing models

## Context

Bench could open STEP, OBJ, PLY and 3MF files in the browser. An imported model
stayed in the browser that opened it, so nobody else in the design saw it and
the STL export left it out. Reading STEP needed a large WebAssembly reader
(occt-import-js) and the one exception to the strict script policy. For a tool
built around everyone seeing the same part, a model only one person can see
did not fit.

## Decision

I removed importing altogether: the File menu item, dropping a file on the
viewport, the importer, the STEP reader and its script exception. Browsers that
kept imported models from before have that storage cleared. The server still
has no route that takes a file and still refuses any body over 32 KB.

## What it costs

- A student cannot bring in an existing part to build around; they model it in
  Bench with typed sizes instead.
- Bench now loads no WebAssembly, and every script runs under the strict
  policy.
