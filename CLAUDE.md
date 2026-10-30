# X4 Home

Home Assistant dashboard OS for the Xteink X4 Pro. Public repo: `daangeijs/ha-paper`. Map of the repo: `README.md`.
Hardware: `docs/HARDWARE.md`.

## Build log blog post (keep it current)

We are writing a blog post about how this project is built. The draft holds device data, so it lives in the
maintainer's private notes repo (`daangeijs/eink-ha-os`, checked out next to this clone:
`../eink-ha-os/docs/blog/building-x4-home.md`), not here; without that checkout, skip this section.

- After any meaningful step (a decision, a bug found, a surprise, something that turned out impossible, a first on
  real hardware), add a dated line under "Notes for the next update of this post". When a note is a real story, fold it
  into the article body.
- Write like an engineer telling a colleague what happened. Concrete details: the actual bug, the actual number, the
  actual error message. Short sentences.
- No AI slop: no "delve", "seamless", "robust", "leverage", "game-changer", "in today's world", no rhetorical
  questions as section openers, no lists of adjectives, no summaries that repeat the section, no hype. If a sentence
  could appear in any other blog post, cut it.
- Be honest: say what failed, what we guessed, what is still untested. Credit decisions to the person who made them.
- Don't repeat the README or the docs; link to them. The post explains *why* and *what we learned*, not how to run it.

## Rules

- The emulator (`emulator/`) is the behaviour spec. Firmware parsing must match `spec/test-vectors/`.
- Record deviations from the original design handoff (not part of this repository) and between emulator and firmware
  as one file per topic in `firmware/deviations/` / `emulator/deviations/` (`NNN-slug.md`, NNN = ha-paper issue
  number, `000` = none, first line `# <topic> (issue #N)`); `make deviations` updates the DEVIATIONS.md index.
- Issue numbers: `#N` means a `daangeijs/ha-paper` issue. `eink-ha-os#N` (and existing deviation file numbers up to
  382) refer to the private tracker the project started in; don't reuse or "fix" them.
- Before calling something done, run: `make test`, `cd emulator && npm run build` (vitest does not type-check),
  `cd firmware && pio run -e x4pro`, and `make qemu-contract` for firmware/API changes.
- Never store or log the HA password; only the encrypted HA refresh token and hashes of API tokens.
- Everything pushed here is public: no personal data in commits, issues, PR bodies, comments or logs (host names,
  IPs, SSIDs, HA URLs, entity ids or soak data from a real home, absolute home paths). Use invented test data.

## How we work (agent team, set up by Daan on 2026-10-15)

The main session is the **product manager / coordinator**. It owns the plan and the board; it delegates the work.

- **Board:** GitHub Project "Project roadmap" (github.com/users/daangeijs/projects/3, private) over the issues of
  `daangeijs/ha-paper`. Fields: Status (Backlog → Ready → In progress → In review → Done), Priority (P0–P2),
  Size (XS–XL). Milestones are releases/sprints: Sprint 1 v0.1.0-alpha.3 *Stable core*, Sprint 2 v0.2.0-beta.1
  *First hardware*, Sprint 3 v0.3.0 *Easy and delightful*, v1.0 *Leave it alone*. Every piece of work is an issue;
  labels: `bug`, `robustness`, `power`, `diagnostics`, `flasher`, `ux`, `visual`, `qemu`, `discovery`,
  `decision`, `hardware-only`, `verify`, `verified`.
- **Product goals** (Daan): easy to install, easy to set up, easy to configure, reliable connection, long battery
  life, a calm good-looking object in the house. Plans and priorities are judged against these.
- **Crew** (subagents, run in parallel):
  - *Discovery* (`cavecrew-investigator`, or general-purpose when web research is needed): read-only. Study vetted
    projects (e.g. crosspoint-reader, TRMNL), our code, or a stuck issue; post findings and an implementation proposal
    as a comment on the issue. When an issue gets stuck, send discovery to investigate or test deeper before
    re-assigning a builder.
  - *Builders*: `x4-engineer` (`.claude/agents/x4-engineer.md`) for multi-file work that must compile and test, each
    in its own git worktree; `cavecrew-builder` for 1–2 file edits without a build. Builders post results on their
    issue, never edit the blog, run QEMU only on their assigned ports, and end their report with a short "Blog note:".
  - *Reviewers/auditors* (`cavecrew-reviewer`, specialists for security, concurrency, flasher safety): review merged
    work before a release. Their findings are verified by the coordinator before acting (reviews produce false
    positives) and become issues.
  - *Council* (strategy agents: product, onboarding/UX, visual design): before each sprint, propose release themes,
    exit criteria and new issues. The coordinator decides; anything that is Daan's call is filed with the `decision`
    label and asked, not assumed.
  - *Writer*: after each merge round, folds dated notes into the blog post (rules above).
- **Pull requests (Daan, 2026-10-16):** every change reaches `main` through a GitHub pull request, never a direct
  push. Builders leave their work uncommitted in the worktree and report files, a commit message and check counts
  (the agent git guard trips mid-commit; 2026-10-17). The coordinator commits, pushes and opens the PR
  (`gh pr create`) titled like the change, body with what/why, the checks run, what is untested, and `Closes #N`.
  Every builder brief names the base sha, the QEMU port pair and the files to stay out of; the coordinator can create
  a ready builder worktree with `make worktree-setup N=<issue> BASE=<sha> PORTS=<http>/<ha>`. CI runs on every PR on
  GitHub-hosted runners, the QEMU job included (`test-and-build` is a required check). The coordinator runs the done-checklist including QEMU locally, then
  `gh pr merge --squash --delete-branch`; the issue closes from the PR. After each merge, check main's push run:
  a red `qemu-firmware` is fixed before new work, and no release is tagged while main is red (2026-10-19: red for two
  days unnoticed, eink-ha-os#193). Docs/blog-only changes by the coordinator
  also go through a PR.
- **User testing (Daan, 2026-10-17):** Daan is the user and verifies user-facing features. Every issue with a
  user-visible change gets the `verify` label and a short "How to verify" block (where, what to do, what should
  happen). Work merges on the automated + local checks and does not wait for Daan per PR, except taste questions he
  asked about (copy, design): show those first. The QEMU test device (http://127.0.0.1:8180, linked to his HA)
  follows main: rebuild it after each merge round. Before tagging a release, send Daan one checklist of the
  `verify` issues (≤ 10 one-line items with links); he tries them on the test device, findings become issues, and
  the release waits for his pass unless he waives it. Confirmed issues swap `verify` for `verified`.
- **Coordinator loop per sprint:** council → plan issues on the board (Ready, priority, size, milestone) → assign
  discovery and builders in parallel → review each PR, run the full done-checklist including QEMU → squash-merge the PR, move the card, add a dated blog note →
  specialist audit at sprint end → Daan's test session → tag the release when the milestone's exit criteria hold → reassess with the council
  and start the next wave.
- **Token discipline:** subagent reports stay short (≤ 25–40 lines); the coordinator reads tails and pass/fail counts,
  not transcripts or full logs; plan state lives in issues, the board and memory so `/compact` loses nothing.
- **One QEMU per port pair:** QEMU tests forward the device to `SIM_HTTP_PORT` and run the fake HA on
  `FAKE_HA_PORT`; state lives in each worktree's `sim/qemu/.state`. 8080/8123 belong to the coordinator (the OTA smoke
  firmware calls 10.0.2.2:8123, so `make qemu-ota` only runs there). Each builder gets its own pair from the coordinator
  (8090/8133, 8100/8143, …) and runs `make qemu-contract` etc. with `SIM_HTTP_PORT=… FAKE_HA_PORT=…` before handing
  back. Never kill a QEMU you didn't start. (2026-10-15: two runs on one port made the contract suite test the wrong
  image; 2026-10-16: a single QEMU slot became the bottleneck, so Daan asked for parallel work.)
- **Shared toolchain:** never let an agent change `~/.platformio` packages (a platform bump must use a private
  `PLATFORMIO_CORE_DIR`); one agent did on 2026-10-15 and broke parallel builds for minutes.
