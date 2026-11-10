# Arena runbook

How to run the public arena on the day. Secrets and the arena project ref live in `~/.ar-copilot/arena.env`, never in
this repo.

## Kill switch (CC-10, pack 03 A4)

Pausing stops every player's copilot at once. Players keep their company, their conversation and their attempts.

**Pause, from a phone (under 30 s).** Open the arena project in the Supabase dashboard, then either:
- **Table editor:** pick the `ctf` schema, open `arena_switch`, set `paused` to `true` and, if you like, type a
  `message` (players see it as written). Save.
- **SQL editor:** run
  ```sql
  update ctf.arena_switch set paused = true, message = 'Back in a few minutes. Nothing is lost.';
  ```

**Resume:**
```sql
update ctf.arena_switch set paused = false, message = null;
```

**What happens.** The agent proxy refuses every request at once, so a message sent while paused gets the arena's
pause wording and a Send again button. The play screen also shows the message and turns Send off within 30 s
(at once for a player who opens or returns to the tab). After resuming, Send comes back within 30 s.
`changed_at` and `changed_by` record the last flip.

Each project has its own switch: pausing the arena never pauses stage. `scripts/reset-stage.sh` turns stage's
switch off, so a drill on stage can't break a beat.

## Leaderboard

`/leaderboard` on the arena's URL is public: open it on the projector with nobody signed in. A signed-in player also
sees their own row marked (or below the list, if they're outside the top 10). Players reach it from **See the
leaderboard** on the Attempts tab.

- **What it shows:** the top 10 by distinct flags, then times fooled, then who reached that score first, with three
  totals (players, times fooled, flags). Handles and counts only, from `public.leaderboard()`: no emails, no prompts,
  no ids (pgTAP 19 and 11, `e2e/leaderboard.e2e.mjs`). A flag a player captures more than once counts once.
- **Live:** a trigger on `ctf.events` and `ctf.players` sends an empty `changed` broadcast on the public Realtime topic
  `arena:leaderboard`, and the page fetches the board again (about once a second at most). The **Live** tag shows the
  channel is connected; if it says **Reconnecting**, the page still refreshes every 15 s. A failed broadcast never
  fails scoring.
- **Not the final word:** before a prize is decided, check each capture in `ctf.events` (kind `flag_captured`); every
  capture already pages a person.

## No stage demo company on the arena

The arena holds Kestrel Freight (the target, with the canaries), the player template and the players' own companies,
nothing else. The shared seed also creates Brightwater Supply and its accounts (Alice and Bob) for stage, but on the
arena a leak of a company with no canaries could never score, so they're removed:

- `scripts/arena-remove-brightwater.sh` previews the counts; `--yes` removes Brightwater Supply, Alice and Bob in one
  transaction (`supabase/arena/remove_brightwater.sql`, pgTAP 20). It targets only the arena from `arena.env`, refuses a
  ref equal to stage's, and leaves Kestrel, its canaries, the template and players as they were. Running it again is
  harmless.
- A fresh arena seed does the same at the end: run `supabase/seed/seed.sql` with `set app.seed_profile = 'arena'`.
  Brightwater is still generated first, so Kestrel's data matches stage's, then removed.
