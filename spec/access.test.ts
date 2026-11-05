// Promise 2 again, for sharing: a design has two links. The edit link (its
// id, /d/<id>) can change it; the view link (/v/<view>) can watch, point,
// follow and export, and nothing more. The server enforces it, says so in
// words, and never tells a viewer the edit link: and the public list of
// designs only ever gives out view links, so it cannot be used to get round it.

import { describe, expect, it } from "vitest";
import { EXAMPLE_ID } from "../shared/example.ts";
import type { Stored } from "../shared/model.ts";
import { unpack } from "../shared/protocol.ts";
import { add, baseUrl, box, id, newDesign, stored, visit } from "./people.ts";

const viewIdOf = (link: string) => link.split("/")[2];

describe("a view-only link", () => {
  it("sees the design and the people in it, and is refused every change, in words", async () => {
    const design = await newDesign("Shared part");
    const a = await visit(design.id, undefined, "Ada");
    expect(a.welcome.access).toBe("edit");
    const f = await add(a, box());
    const view = viewIdOf(a.welcome.links.view);
    const v = await visit(view, undefined, "Vic", "view");
    expect(v.welcome.access).toBe("view");
    expect(v.welcome.features.map((x) => x.id)).toEqual([f.id]);
    await a.next("people", (m) => m.people.some((p) => p.id === v.you.id));

    for (const msg of [
      { t: "add" as const, id: id(), f: box() },
      { t: "update" as const, id: f.id, base: 1, f: box({ w: 99 }) },
      { t: "delete" as const, id: f.id, base: 1 },
      { t: "hold" as const, ids: [f.id] },
      { t: "rename" as const, name: "Mine now" },
    ]) {
      v.send(msg);
      const no = await v.next("reject");
      expect(no.reason, msg.t).toBe("readonly");
      expect(no.message).toMatch(/view-only/);
    }
    expect(await stored(design.id)).toMatchObject([{ id: f.id, w: 10, v: 1 }]);

    // and it still sees the editor's changes as they happen
    a.send({ t: "update", id: f.id, base: 1, f: box({ w: 42 }) });
    expect((await v.next("put", (m) => m.feature.id === f.id)).feature).toMatchObject({ w: 42 });
    await Promise.all([a.close(), v.close()]);
  });

  it("never learns the edit link", async () => {
    const design = await newDesign("Secret");
    const a = await visit(design.id);
    const view = viewIdOf(a.welcome.links.view);
    expect(view).not.toBe(design.id);
    const v = await visit(view, undefined, "Vic", "view");
    expect(JSON.stringify(v.welcome)).not.toContain(design.id);
    expect(v.welcome.links.edit).toBeUndefined();
    a.send({ t: "rename", name: "Renamed" });
    const renamed = await v.next("design");
    expect(JSON.stringify(renamed)).not.toContain(design.id);
    await Promise.all([a.close(), v.close()]);
  });

  it("opens the page and exports the STL", async () => {
    const design = await newDesign();
    const a = await visit(design.id);
    await add(a, box());
    const view = viewIdOf(a.welcome.links.view);
    await a.close();
    expect((await fetch(new URL(`/v/${view}`, baseUrl))).status).toBe(200);
    const stl = await fetch(new URL(`/v/${view}/export.stl`, baseUrl));
    expect(stl.status).toBe(200);
    expect((await stl.arrayBuffer()).byteLength).toBeGreaterThan(84);
  });
});

describe("the list of designs", () => {
  it("gives out view links only, except for the example, which anyone may edit", async () => {
    const design = await newDesign("Not for editing by strangers");
    const list = (await (await fetch(new URL("/api/designs", baseUrl))).json()) as { link: string; name: string }[];
    expect(JSON.stringify(list)).not.toContain(design.id);
    const mine = list.find((d) => d.name === "Not for editing by strangers");
    expect(mine?.link).toMatch(/^\/v\//);
    expect(list.find((d) => d.link === `/d/${EXAMPLE_ID}`)).toBeTruthy();
  });
});

describe("thumbnails by view link", () => {
  it("give the design's features to a view link, and never its edit id", async () => {
    const design = await newDesign("Thumbnail me");
    const a = await visit(design.id);
    await add(a, box({ w: 33 }));
    const view = viewIdOf(a.welcome.links.view);
    await a.close();
    const res = await fetch(new URL(`/api/views/${view}`, baseUrl));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(design.id);
    const body = JSON.parse(text) as { name: string; features: Stored[] };
    expect(body.name).toBe("Thumbnail me");
    expect(body.features.map((f) => unpack(f))).toEqual(await stored(design.id));
    // an edit id is not a view link
    expect((await fetch(new URL(`/api/views/${design.id}`, baseUrl))).status).toBe(404);
  });
});

describe("the home page and the guest cookie", () => {
  it("greets a returning guest by the name in their cookie, escaped, and nobody else", async () => {
    const plain = await (await fetch(new URL("/", baseUrl))).text();
    expect(plain).toContain('<body class="land">');
    const res = await fetch(new URL("/", baseUrl), { headers: { Cookie: `bench_guest=${encodeURIComponent('Ada <b>"x"')}` } });
    expect(res.headers.get("vary")).toMatch(/cookie/i);
    const page = await res.text();
    expect(page).toContain('<body class="land known">');
    expect(page).toContain("Ada &#60;b&#62;&#34;x&#34;");
    expect(page).not.toContain("<b>\"x\"");
  });
});
