---
'@stellar-starter-kit/types': minor
'@stellar-starter-kit/sdk': minor
---

Add `StreamsClient.getVestingSummary(id)`, which reads `{ vested, claimable }`
as `bigint`s from the contract's `vesting_summary` view in one simulation, and
`StreamsClient.pause(id, opts?)` / `resume(id, opts?)` for the contract's pause
entry points. Contract errors `#16` and `#17` now map onto `StreamsError.code`
as `STREAM_PAUSED` and `NOT_PAUSED`. `@stellar-starter-kit/types` exports the
`VestingSummary` type and its `normalizeVestingSummary` decoder.
