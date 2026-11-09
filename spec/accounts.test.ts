// Accounts (docs/adr/0005-accounts.md). Starting a design takes an account,
// and an account's projects are kept by the server, on a page of their own.
// Joining a design by its link still takes nothing: a guest with the edit
// link edits, as before. A password is never answered back, a session lives
// in an HttpOnly cookie, and nobody sees another account's projects.

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EXAMPLE_ID } from "../shared/example.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { add, baseUrl, box, newDesign, sessionCookie, signUp, stored, token, visit, type Account } from "./people.ts";

const post = (path: string, body: unknown, cookie = "", extra: Record<string, string> = {}) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: JSON.stringify(body),
    redirect: "manual",
  });

const get = (path: string, cookie = "") => fetch(new URL(path, baseUrl), { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });

type Project = { link: string; view: string; name: string; access: "edit" | "view"; mine: boolean };
const projects = async (a: Account): Promise<Project[]> => (await (await get("/api/projects", a.cookie)).json()) as Project[];

// Opens a design as a signed-in browser would: the session cookie rides on
// the socket's upgrade request. Resolves with the welcome, then hangs up.
function openSignedIn(a: Account, via: "design" | "view", id: string): Promise<Extract<ServerMessage, { t: "welcome" }>> {
  const url = new URL(`/ws?${via}=${id}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { Cookie: a.cookie } });
  return new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token: token(), name: "Not my account name" })));
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      if (m.t !== "welcome") return;
      ws.close();
      ws.on("close", () => resolve(m));
    });
    ws.on("error", reject);
  });
}

describe("making an account", () => {
  it("signs you in with an HttpOnly cookie and never answers the password back", async () => {
    const email = `spec-${token().slice(0, 10)}@example.com`;
    const res = await post("/api/signup", { email: email.toUpperCase(), password: "correct horse", name: "Ada" });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("correct horse");
    const set = res.headers.getSetCookie().find((c) => c.startsWith("bench_session="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const me = await get("/api/me", sessionCookie(res));
    // emails are kept in lower case, so the same address is one account
    expect(await me.json()).toEqual({ name: "Ada", email });
  });

  it("refuses a taken email, a short password and a missing name, in words", async () => {
    const a = await signUp();
    const taken = await post("/api/signup", { email: a.email, password: "another password", name: "Bo" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toMatch(/already has an account/);
    const short = await post("/api/signup", { email: `x${a.email}`, password: "short", name: "Bo" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: string }).error).toMatch(/8 characters/);
    const noName = await post("/api/signup", { email: `y${a.email}`, password: "long enough", name: "  " });
    expect(noName.status).toBe(400);
    expect(((await noName.json()) as { error: string }).error).toMatch(/name/);
  });
});

describe("signing in and out", () => {
  it("lets the right password in and refuses a wrong one or an unknown email with the same words", async () => {
    const a = await signUp("Cy");
    const ok = await post("/api/signin", { email: a.email, password: a.password });
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok);
    expect(cookie).not.toBe(a.cookie);
    expect(((await (await get("/api/me", cookie)).json()) as { name: string }).name).toBe("Cy");

    const wrong = await post("/api/signin", { email: a.email, password: "not it at all" });
    const nobody = await post("/api/signin", { email: `nobody-${a.email}`, password: a.password });
    expect(wrong.status).toBe(401);
    expect(nobody.status).toBe(401);
    // the refusal does not say which of the two was wrong
    expect(await wrong.text()).toBe(await nobody.text());
    expect(sessionCookie(wrong)).toBe("");
  });

  it("ends the session on the server when you sign out", async () => {
    const a = await signUp();
    expect((await get("/api/me", a.cookie)).status).toBe(200);
    const out = await post("/api/signout", {}, a.cookie);
    expect(out.headers.getSetCookie().join()).toMatch(/bench_session=;.*Max-Age=0/);
    // the old cookie, kept and sent again, no longer signs anyone in
    expect((await get("/api/me", a.cookie)).status).toBe(401);
    expect((await get("/projects", a.cookie)).status).toBe(302);
  });

  it("refuses an account change sent from another site's page", async () => {
    const a = await signUp();
    const res = await post("/api/designs", { name: "Planted" }, a.cookie, { Origin: "https://elsewhere.example" });
    expect(res.status).toBe(403);
  });
});

describe("starting a design", () => {
  it("takes an account, and says so in words", async () => {
    const res = await post("/api/designs", { name: "No account" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/sign in|account/);
  });

  it("but joining one by its edit link does not: a guest edits", async () => {
    const design = await newDesign("Open to guests");
    const guest = await visit(design.id, token(), "Guest Gil");
    expect(guest.welcome.access).toBe("edit");
    const f = await add(guest, box({ w: 12 }));
    expect(await stored(design.id)).toMatchObject([{ id: f.id, w: 12 }]);
    await guest.close();
  });
});

describe("the projects page", () => {
  it("is for signed-in accounts: anyone else is sent to sign in", async () => {
    const res = await get("/projects");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin?next=/projects");
    expect((await get("/api/projects")).status).toBe(401);
  });

  it("is a page of its own, with the account's name in it, escaped", async () => {
    const a = await signUp('Ada <b>"x"');
    const res = await get("/projects", a.cookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Ada &#60;b&#62;&#34;x&#34;");
    expect(page).not.toContain('<b>"x"');
    expect(page).toContain('id="pj-list"');
  });

  it("sends someone already signed in from /signin straight to it", async () => {
    const a = await signUp();
    const res = await get("/signin", a.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects");
    // and never to another site, whatever ?next= says
    expect((await get("/signin?next=//elsewhere.example", a.cookie)).headers.get("location")).toBe("/projects");
  });

  it("lists the designs you made and the ones you opened, each with the link you were given", async () => {
    const ada = await signUp("Ada");
    const bo = await signUp("Bo");
    const made = await newDesign("Ada's bracket", ada);
    const shared = await newDesign("Bo's gear", bo);
    const watched = await newDesign("Bo's housing", bo);
    expect((await projects(ada)).map((p) => p.name)).toEqual(["Ada's bracket"]);

    await openSignedIn(ada, "design", shared.id);
    await openSignedIn(ada, "view", watched.view);
    const list = await projects(ada);
    expect(list.map((p) => p.name)).toEqual(["Bo's housing", "Bo's gear", "Ada's bracket"]);
    expect(list.find((p) => p.name === "Ada's bracket")).toMatchObject({ access: "edit", mine: true, link: `/d/${made.id}` });
    expect(list.find((p) => p.name === "Bo's gear")).toMatchObject({ access: "edit", mine: false, link: `/d/${shared.id}` });
    // a view link gives only the view link: the list never leaks an edit id
    const view = list.find((p) => p.name === "Bo's housing")!;
    expect(view).toMatchObject({ access: "view", mine: false, link: `/v/${watched.view}` });
    expect(JSON.stringify(list)).not.toContain(watched.id);

    // an edit link once held is kept, even when the view link is opened later
    await openSignedIn(ada, "view", shared.view);
    expect((await projects(ada)).find((p) => p.name === "Bo's gear")).toMatchObject({ access: "edit" });

    // nobody sees anyone else's list
    expect((await projects(bo)).map((p) => p.name).sort()).toEqual(["Bo's gear", "Bo's housing"]);
  });

  it("leaves out the example, which is everyone's", async () => {
    const a = await signUp();
    await openSignedIn(a, "design", EXAMPLE_ID);
    expect(await projects(a)).toEqual([]);
    expect((await post("/api/projects", { link: `/d/${EXAMPLE_ID}` }, a.cookie)).status).toBe(400);
  });

  it("adds a design by a link you hold, and removes one without touching the design", async () => {
    const owner = await signUp();
    const a = await signUp();
    const design = await newDesign("Kept from before", owner);
    expect((await post("/api/projects", { link: `https://bench.example/v/${design.view}` }, a.cookie)).status).toBe(201);
    expect(await projects(a)).toMatchObject([{ name: "Kept from before", access: "view" }]);
    expect((await post("/api/projects", { link: "/d/nosuchthing" }, a.cookie)).status).toBe(404);

    const gone = await fetch(new URL(`/api/projects/${design.view}`, baseUrl), { method: "DELETE", headers: { Cookie: a.cookie } });
    expect(gone.status).toBe(200);
    expect(await projects(a)).toEqual([]);
    expect((await projects(owner)).map((p) => p.name)).toEqual(["Kept from before"]);
  });
});

describe("an account in a design", () => {
  it("is the same person, under its own name, on every connection", async () => {
    const a = await signUp("Dee");
    const design = await newDesign("Two tabs", a);
    const one = await openSignedIn(a, "design", design.id);
    const two = await openSignedIn(a, "design", design.id);
    expect(one.you.name).toBe("Dee");
    expect(two.you.id).toBe(one.you.id);
  });
});

describe("the home page", () => {
  it("greets someone signed in by their account's name, escaped, and nobody else", async () => {
    const plain = await (await get("/")).text();
    expect(plain).toContain('<body class="land">');
    // the guest name cookie is the browser's own; it does not sign anyone in
    const guest = await (await get("/", "bench_guest=Ada")).text();
    expect(guest).toContain('<body class="land">');
    const a = await signUp('Ada <b>"x"');
    const res = await get("/", a.cookie);
    expect(res.headers.get("vary")).toMatch(/cookie/i);
    const page = await res.text();
    expect(page).toContain('<body class="land known">');
    expect(page).toContain("Ada &#60;b&#62;&#34;x&#34;");
    expect(page).not.toContain('<b>"x"');
  });
});
