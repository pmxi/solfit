# Issue: `settle` fails with `NotActive` when a room starts under-filled

## Symptom

At the end of the game, `GameResults` calls `settleWithJudgeServer` and the
transaction reverts:

```
AnchorError thrown in programs/solfit/src/lib.rs:77.
Error Code: NotActive. Error Number: 6005.
Error Message: contest is not Active.
```

The UI shows "YOU WON!" and a computed prize, but the on-chain pot is never
paid out.

## Root cause

The on-chain contest never reaches `Active`. In `lib.rs:65-69`:

```rust
if (c.players.len() as u8) == c.max_players {
    c.start_time = now;
    c.deadline   = now + c.duration as i64;
    c.status     = ContestStatus::Active as u8;
}
```

`Active` is set **only** when the room fills. In the reproduction, `max_players`
was 2 (default in `CreateTeam.tsx:21`) but only the host joined, so status
stayed `Open`. `settle` (lib.rs:77) requires `Active`, hence `NotActive`.

The UI game timer is purely client-side and unrelated to the on-chain
`deadline` (which is `0` while `status == Open`). The timer expires and the
client calls `settle` against a contest that was never armed.

## Why nothing prevents this

- `GameSettings.tsx:28` "Confirm & Start" has no player-count gate — the host
  can start with a lobby of one.
- `server/index.js:249` `start-game` also has no gate.

## The deeper problem: stuck funds

There is no on-chain path to close a partially-filled contest:

- `settle` requires `Active` → rejected.
- `refund_timeout` requires `Active` too (`lib.rs:138`) → rejected.
- `withdraw_refund` requires `Refunding`, which is unreachable from `Open`.

Every player who called `join_contest` on an under-filled room has their
`wager` transferred into the PDA (`lib.rs:52-60`). Those lamports are
**trapped forever** because no instruction can transition an `Open` contest
to a state that lets them out.

In the reproduction only the host joined, so only the host's wager is stuck
— but the failure mode generalizes: any N-player room with fewer than N
joins leaves all joined players' wagers locked.

## Reproduction

1. Create a room with `max_players = 2`.
2. Do not invite/wait for a second player.
3. Press "Confirm & Start".
4. Let the client-side timer run out.
5. `GameResults` auto-settles → `NotActive`.

## Proposed fixes

In order of increasing surgery:

1. **UI gate (prevents the bug).** Disable "Confirm & Start" until
   `room.players.length === max_players`; show "waiting for N more players".
   Cheap, immediate. Does not address already-stuck funds or an intentional
   abandon.

2. **On-chain `refund_open` instruction (real fix).** Add an ix that any
   joined player can call when `status == Open` to reclaim their `wager`
   and, once all joined players have withdrawn, close the PDA. This closes
   the dead-end state in the state machine.

3. **Optional: `start_contest` ix for early start.** Let the host force
   `Active` with fewer than `max_players`, truncating `players` /
   `withdrawn`. Only worth it if we actually want sub-max games; otherwise
   (1) + (2) is sufficient.

Recommendation: ship (1) now, then (2). (3) only if product wants it.

## Affected files

- `anchor/programs/solfit/src/lib.rs` — state machine (for fix 2/3).
- `frontend/src/app/components/GameSettings.tsx` — start button (for fix 1).
- `frontend/src/app/components/CreateTeam.tsx` — default `maxPlayers` is 2.
- `frontend/src/context/GameContext.tsx` — `emitStartGame` / auto-join flow.
- `frontend/src/app/components/GameResults.tsx` — where the failing settle
  is observed; could also pre-check `contest.status == Active` and surface
  a clearer error instead of submitting a doomed tx.
