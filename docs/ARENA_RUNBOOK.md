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
