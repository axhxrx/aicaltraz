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
| A press made in a dead zone ran 14–45 s later, after the phone had said NO RESPONSE (TCP delivered it late) | ladder, rider, chaos | fixed (2c036fe) |
| Results vanish after 2.5 s; failures go unseen; nothing survives a reconnect | ladder, rider, crew | fixed (2c036fe) |
| Confirm/hold enforced only in the browser; press token can fire "Format card" via API | admin, crew | fixed (2c036fe) |
| Remote key chatter double-sends; confirm beaten by chatter or a pothole bounce | rider | fixed (2c036fe) |
| Saving an edit that removes/renames a running button kills it silently | crew, admin, edit review | fixed (2c036fe) |
| Kiosk `?lock&pad=X` silently becomes another pad's remote when X is renamed/deleted | crew, chaos, rider | fixed (2c036fe) |
| Host crash: orphaned action keeps running, next press runs a second copy, run ids restart | crew, chaos | fixed (2c036fe) |
| Saving on a full disk truncated the config and reported success | chaos | fixed (2c036fe) |
| ALL OFF can't stop other running actions | ladder | fixed: `stops` + `none` (2c036fe) |
| No persistent device state (is it recording? are lights on?) | rider, admin | fixed: `@state` chips (2c036fe) |

Round-1 fixes landed in 2c036fe (335 bun tests, 314 Playwright tests); the full list of accepted
items is in that commit's message.

## Round 2 (frozen build 2c036fe)

Five agents: a regression verifier re-running the round-1 repro scripts, two new personas, and
adversarial security + correctness reviews of the round-2 code.

| Persona / review | Scale |
|---|---|
| Regression verifier | every round-1 HIGH item re-run with the original scripts |
| Kenji, Tokyo stage manager | 2 shows × 18 cues, JP/EN labels, kiosk tablet + phone, Wi-Fi blips, host crash mid-cue |
| Pat, hobbyist | Pi-class host, 360×640 phone at 5–6× CPU throttle, flaky Wi-Fi, set up entirely from the phone |
| Security review | state file, confirm/`at` abuse, rate-limit spoofing, sanitizing, temp-file attacks |
| Correctness review | interactions of requeue × stops × persistence × clock offsets × attribution |

What held up: all 9 HIGH round-1 bugs verified fixed with their original repros (late presses
dropped at 3.4–45 s, confirm bypasses refused, chatter/bounce sent 0 extra, kiosk shows "pad no
longer exists", orphans killed after kill -9, disk-full leaves the file intact); exactly-once still
holds under contention; 59/59 hobbyist runs exactly once at 6× throttle; touch-to-feedback 18–34 ms.

| Finding | Reported by | Status |
|---|---|---|
| Slow/large hello skewed the clock offset → every press expired, reconnect loop | correctness, regression | fixed (d0df424) |
| State-file fingerprint is computable → a writable state file could aim the startup kill | security | fixed: trust only a private, host-owned file (d0df424) |
| NO RESPONSE never resolved after a dead zone (expired ack went to the dead socket) | stage, hobbyist | fixed: resolves to DIDN'T RUN (d0df424) |
| Kept failures swallowed the next tap/key (a remote can't "hold to retry") | regression, stage | fixed: press retries, ✕ clears (d0df424) |
| Run attribution: stale queue claims, 30 s claim window, restarted run ids | correctness | fixed (d0df424) |
| "All off" refusable by run/rate limits | correctness | fixed (d0df424) |
| Rough mode disabled palm rejection; ?lock didn't confine keys; ghost runs after edits | correctness, regression | fixed (d0df424) |
| Raising a running cue's time limit mid-show didn't apply | stage | round 4 |
| No phone-only way to become admin | hobbyist | round 4 (pairing codes) |
| Results flood the screen bright in a dark house | stage | round 4 (show mode) |
| Two one-sided fades fight; no exclusive groups | stage | round 4 (`group`) |
| Trailing space in a program path broke a button invisibly | hobbyist | round 4 (trimmed paths) |
