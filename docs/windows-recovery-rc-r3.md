# RC R3: Windows agent and misao recovery

These checks are pending. Record the Windows version, release candidate, task names, timestamps, and logs with the results. Use a disposable installation: stopping or updating misao closes its panes.

## Checks requiring a Windows session

- [ ] With an agent and misao running under their new task definitions, stop the hub and forcibly end each process. Confirm each returns without the hub, with one process per service and the expected 5, 10, 20, 40, then 60 second retry intervals. Keep failures going beyond the first 60-second interval; after a run of at least five minutes, confirm the next delay resets to five seconds.
- [ ] Log off the task owner during a failure and while a retry is pending. Record whether the tasks and child processes end, whether any process survives without its launcher, and what happens after the owner logs on again. Repeat with the hub stopped. Do not assume recovery while logged off.
- [ ] Verify normal `misao stop`, Task Scheduler `/End`, and disabling each task do not cause the launcher to retry. With the hub running, separately verify its watchdog's documented recovery of a manually stopped task and that disabling the task prevents recovery.
- [ ] Exercise explicit agent reinstall/update and misao install/update from legacy definitions. Confirm a running misao is untouched by install, an explicit update migrates it, and a failed update restores the previous task and pointer and restarts the previously running version. Confirm a foreign or modified task is left untouched.
- [ ] Confirm the watchdog leaves a running launcher alone during its retry wait and rechecks state after acquiring the relevant lock. Exercise update and removal while a retry is pending and check for orphaned processes or duplicate launches.
- [ ] Repeat with paths containing spaces, parentheses, apostrophes and non-ASCII characters; verify logs and task command-length rejection. Check log growth during prolonged failure.

## Windows CI evidence

The repository contains Windows integration tests and `packages/server/scripts/smoke-recovery-win32.ts` for recovery, clean stop, `/End` and disabled-task behavior. They were added or updated for this change but **have not been run in the Linux implementation environment**. Record the CI run and results here before treating those checks as verified; investigate any skipped or failed step. CI does not replace the logoff and prolonged-failure checks above.
