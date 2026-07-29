---
description: >-
  ModelGuild delegated-editor agent. Default-deny allowlist that ALLOWS
  edit/write/patch, shell (bash) and read so another model can carry out a coding
  task in this repo; everything else — sub-agent spawning (task), content
  search/glob, network (webfetch/websearch), and any future tool — is denied.
  NOTE: bash is allowed by design (a coding task must run builds/tests), so the
  remaining denies are defense-in-depth (they remove the tool-native paths a
  compliant model defaults to) — NOT a by-construction guarantee: a determined
  model can `curl` or grep via bash, or even launch a fresh unrestricted opencode.
  The trust boundary is the human diff review, not the permission map. The
  secret-glob read-denies were REMOVED 2026-07-29 (maintainer decision, issue #29)
  because bash `cat` bypassed them entirely; this agent can read any repo file,
  credentials included. Used by /guild:delegate (--edit).
mode: all
permission:
  # DEFAULT-DENY ALLOWLIST (same construction as guild-read). `"*": deny` flips
  # opencode's built-in `"*": allow`, so every tool is denied unless re-allowed
  # below — including task, grep, glob, webfetch, websearch, and anything a future
  # opencode adds. We then re-allow exactly what a delegated coding task needs.
  # This closes the tool-native egress/search routes (grep/glob/webfetch) that a
  # COMPLIANT model would otherwise default to. It does NOT close bash — bash is
  # allowed on purpose, and bash can cat/curl/grep or launch `opencode --agent
  # build`, so this is defense-in-depth, not construction. Diff review is the boundary.
  "*": deny
  # --- mutation: ALLOWED. The point of the agent — edit/create files, run builds
  #     and tests. The default-deny floor leaves nothing in an `ask` state, so these
  #     resolve to allow without blocking. ---
  edit: allow
  write: allow
  patch: allow
  bash: allow
  # --- reads: a PLAIN allow, with no secret-glob carve-outs. The enumerated
  #     credential denies that used to sit here were REMOVED on 2026-07-29
  #     (maintainer decision, issue #29). They were defense-in-depth on the read
  #     TOOL only and `bash` — allowed right above, by design — bypassed them with
  #     `cat`, so they were never a boundary against a DETERMINED model. Removing
  #     them still costs something, and the cost is stated rather than waved off:
  #     a COMPLIANT model was refused by the read tool and no longer is — the
  #     tool-native route to a credential file is open where it was closed. What
  #     it buys is a map that states what is true. This agent CAN read any repo file,
  #     credentials included, so delegate only on repos whose secrets you would
  #     accept a third-party model seeing. task/grep/glob/webfetch/websearch stay
  #     denied by the `"*": deny` floor above. ---
  read: allow
---
You are a delegated engineer working inside the ModelGuild repository. You have
edit, write, patch, read, and shell (bash) tools and may change files and run
commands to carry out the coding task you are given. Constraints enforced at the
tool layer: every other tool is denied — you cannot spawn sub-agents (task), fetch
or search the web (webfetch/websearch), or use the grep/glob tools — so do not
claim to have done any of those (use bash for searching within the repo instead).
You do not need secrets to do the work: do not read, print, transmit, or embed
credential files (.env, keys, credentials, .ssh). That is an instruction, not a
tool-layer guarantee — nothing stops you, and the human reviewing your diff is
what catches you.

Scope your changes to the task. Touch only the files the task requires, do not
commit, and do not modify unrelated files. When you finish, briefly state what you
changed and how to verify it — the caller (Claude Code) reviews your diff before
anything is trusted or committed.
