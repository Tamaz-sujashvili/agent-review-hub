# Load test

Run separately from the normal scenario suite, with Node 22.13 or newer:

```sh
pnpm --filter @quorum/e2e load
```

The fixture starts one Leader and eight real Node daemons using mock adapters,
then submits 60 tasks in a burst: 30 own, 30 pool, with exactly 12 requesting
one revision. Four nodes own tasks and four peers lend sessions; all mocks
support both profiles because pool work can make a peer an author. Each mock
turn has a seeded random delay between 50 and 500 ms. Task files are disjoint
so merge conflicts do not obscure scheduling failures.

Every task must reach MERGED within ten minutes; an ESCALATED task fails the
test. SQLite audit triggers in the disposable fixture record every committed
session lock change and task command, so lock assertions also cover activity between polls. The
test checks approvals against actual main-branch commits and checks for
remaining locks before teardown. It prints progress, total workload time and
the ten slowest tasks, including on failure.

Use `QUORUM_LOAD_SEED=20261018` to reproduce a workload (the default seed), or
choose another unsigned 32-bit seed. Set `QUORUM_E2E_KEEP=1` to preserve the
fixture path printed in the report for debugging. This suite is excluded from
`pnpm e2e` and the normal CI scenario run.
