# 04 — Apps (owner: TBD, decision D7)

Read `00_SHARED_CONTEXT.md` first. Two front ends, one stack. Framework is your
choice; hosting per D3 (AWS hosting preferred). Both apps use Supabase Auth for
first-party sign-in and talk to the agent through AgentCore Runtime.

The apps are **thin**. All authorization lives in Postgres. The apps never decide
what a user or agent may see or do; they display what the DB returns.

## 1. AR app (`apps/ar-app/`): the stage and booth product
Users: Alice (admin) and Bob (rep) at Brightwater Supply.

- **AR views:** aging buckets, overdue invoice list, customer detail, unmatched
  payments (showing remittance memos), dunning drafts and sent emails. This must look
  like a real product a finance team would use. That realism is the
  "production-ready" claim.
- **Copilot panel:** chat with the agent, streaming. Tool calls are visible as
  compact chips with outcome badges (ok / **denied** / proposal created). The
  denied badge is a stage moment, so make it legible on a projector.
- **Approvals inbox:** `pending_actions` arrive live via Realtime. Approve/reject
  shows who requested it (user + agent). Approving executes the action as the
  **human**.
- **Agent access page:** "Connect agent" (starts the 3LO consent flow, see pack 03)
  and **"Revoke agent access"** (sets `revoked_at`; stage beat 5). Shows the grant
  status.
- **Stage mode:** large type, a high-contrast theme, and a split layout that
  doesn't fight the recording (copilot left, product/approvals right). Toggle via
  URL param.

## 2. Arena app (`apps/arena/`): the audience CTF
- **Sign-in:** work email (magic link) and/or LinkedIn. **Consent + privacy text is
  pending legal/marketing.** Leave a clearly marked placeholder and don't ship the
  arena publicly without it.
- **First sign-in** → provisioning (pack 02) → the player sees their tenant and
  their generated handle (no user-chosen names).
- **Brief page:** the rules, the four flags, the hint that Kestrel Freight invoices
  look like `KST-2026-####`, what counts as a capture, the prize, and the "found a
  real hole?" policy (text TBD by the humans).
- **Chat:** the same copilot panel as the AR app, against the player's own tenant,
  plus a simplified view of their data so they can plan attacks.
- **Level 2 (stretch):** a "Send Kestrel a payment" form (amount + memo) that
  writes to Kestrel's bank feed via a trusted function, rate-limited.
- **Respect the kill switch and per-player limits** (pack 03) with friendly copy.
- **Mobile-first.** People will play from their phones in the audience.

## Acceptance criteria
| ID | Criterion                                                                                                           |
|----|---------------------------------------------------------------------------------------------------------------------|
| P1 | Stage beats 1–5 can be driven entirely from the AR app in stage mode.                                               |
| P2 | Denied tool calls and new proposals are visually unmistakable from 10 m.                                            |
| P3 | Realtime approvals appear in under 2 s.                                                                             |
| P4 | Arena: QR code → signed in → first prompt in under 60 s on a phone.                                                 |
| P5 | No authorization logic in the apps (review: removing every client-side check changes nothing about what's allowed). |
| P6 | No raw prompts from other players are ever displayed.                                                               |
