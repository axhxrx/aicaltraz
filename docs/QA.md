# QA log

How ButtPad was tested before a human touched it: builder agents wrote the code, adversarial
reviewer agents attacked it (each finding had to come with a reproduction), fixer agents fixed
what the orchestrator accepted, and simulated-user agents dogfooded a frozen build in a real
Chromium against a real host running real (fake-device) scripts.

## Adversarial reviews (round 1)

| Review | Proven findings | Worst |
|---|---|---|
| Host security | 0 critical/high, 3 medium, 3 low | dev mode on by default exposed source maps + HMR socket on the LAN; no socket/press limits |
| Host correctness | 2 high, 4 medium, 5 low | output flood froze the host for seconds; shutdown during kill grace orphaned processes |
| Web run mode | 6 high, 6 medium, 1 low | dead link showed LIVE ~80 s; stale socket pinned OFFLINE; phantom holds under main-thread stalls; late-delivered press after NO RESPONSE |
| Edit mode | 2 high, 8 medium, 6 low | one tap on "Load theirs" wiped the draft; draft lost on reload/re-pair; invalid hand edit silently overwritten |

All accepted findings were fixed with regression tests (host: 171 bun tests; web: 174 Playwright
tests at the first verified checkpoint).

## Dogfooding round 1 (frozen build 6a465d5)

Five simulated users, each with its own host, config and ground-truth logs:

| Persona | Device | Scale |
|---|---|---|
| Aki, lighting tech on a ladder | phone portrait, one hand | 105 runs, 20 scenarios, 2.5 min continuous session |
| Mason, rider on a handlebar mount | phone landscape, gloves, BLE remote | ~180 gestures/keys, 5-min seeded route, real dropped packets |
| Mari, first-time admin | desktop + phone | built two pads from scratch in the editor |
| A crew of four devices + manager | 2 phones, kiosk tablet, laptop | 357 contended runs, audited against host log + raw WS observer |
| Chaos monkey | everything | full-disk, FIFO configs, SIGSTOP, 31 pads, 2.6 MB configs, hostile output |

What held up: exactly-once execution under contention (357 runs, host log = observer = acks);
devices agreeing within 3–5 ms; OFFLINE unmistakable in glare/grayscale; drift tolerance exact;
press role fully fenced; hostile protocol input, huge outputs and config churn.

Top findings and what happened to them:

| Finding | Reported by | Status |
|---|---|---|
| A press made in a dead zone ran 14–45 s later, after the phone had said NO RESPONSE (TCP delivered it late) | ladder, rider, chaos | round 2 |
| Results vanish after 2.5 s; failures go unseen; nothing survives a reconnect | ladder, rider, crew | round 2 |
| Confirm/hold enforced only in the browser; press token can fire "Format card" via API | admin, crew | round 2 |
| Remote key chatter double-sends; confirm beaten by chatter or a pothole bounce | rider | round 2 |
| Saving an edit that removes/renames a running button kills it silently | crew, admin, edit review | round 2 |
| Kiosk `?lock&pad=X` silently becomes another pad's remote when X is renamed/deleted | crew, chaos, rider | round 2 |
| Host crash: orphaned action keeps running, next press runs a second copy, run ids restart | crew, chaos | round 2 |
| Saving on a full disk truncated the config and reported success | chaos | round 2 |
| ALL OFF can't stop other running actions | ladder | round 2 (`stops`) |
| No persistent device state (is it recording? are lights on?) | rider, admin | round 2 (`@state`) |

Full triage (every accepted item) lives in the fix-round commit messages.
