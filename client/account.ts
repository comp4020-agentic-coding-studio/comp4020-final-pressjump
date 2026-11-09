// /signin and /signup: one page, one form. The server decides which by the
// body's class, and sets the session cookie; this only sends the form and
// goes on to /projects (or wherever ?next= says, on this site).

import { setGuestName } from "./guest.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const signup = document.body.classList.contains("signup");
document.title = signup ? "Create an account · Bench" : "Sign in · Bench";
$<HTMLInputElement>("acct-password").autocomplete = signup ? "new-password" : "current-password";
$<HTMLInputElement>("acct-name").required = signup;

// carry ?next= across the switch between the two
const next = new URLSearchParams(location.search).get("next");
const target = next && /^\/(?!\/)/.test(next) ? next : "/projects";
if (next) {
  for (const a of [$<HTMLAnchorElement>("to-signup"), $<HTMLAnchorElement>("to-signin")]) a.search = `?next=${encodeURIComponent(next)}`;
}

const form = $<HTMLFormElement>("acct-form");
const error = $<HTMLParagraphElement>("acct-error");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.textContent = "";
  const data = new FormData(form);
  const button = form.querySelector("button") as HTMLButtonElement;
  button.disabled = true;
  try {
    const res = await fetch(signup ? "/api/signup" : "/api/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: data.get("email"), password: data.get("password"), name: signup ? data.get("name") : undefined }),
    });
    const body = (await res.json()) as { name?: string; error?: string };
    if (!res.ok || !body.name) throw new Error(body.error ?? "that did not work");
    // the editor reads the name from here, as it does a guest's
    setGuestName(body.name);
    location.href = target;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error.textContent = msg.charAt(0).toUpperCase() + msg.slice(1) + ".";
    button.disabled = false;
  }
});
