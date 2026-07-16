export type TransferableMonitorRunner = {
  accountId: number;
  timer: unknown | null;
  running: boolean;
  stopped: boolean;
};

export function transferMonitorRunnerInPlace<TRunner extends TransferableMonitorRunner>(
  runners: Map<number, TRunner>,
  fromAccountId: number,
  toAccountId: number,
  dependencies: {
    clearTimer(timer: NonNullable<TRunner["timer"]>): void;
    schedule(runner: TRunner): void;
  },
) {
  if (fromAccountId === toAccountId) {
    return { transferredRunner: runners.get(fromAccountId) ?? null, replacedRunner: null };
  }

  const runner = runners.get(fromAccountId);
  if (!runner) {
    return { transferredRunner: null, replacedRunner: null };
  }

  if (runner.timer != null) {
    dependencies.clearTimer(runner.timer as NonNullable<TRunner["timer"]>);
    runner.timer = null;
  }

  const existingTarget = runners.get(toAccountId);
  const replacedRunner = existingTarget && existingTarget !== runner ? existingTarget : null;
  if (replacedRunner) {
    replacedRunner.stopped = true;
    if (replacedRunner.timer != null) {
      dependencies.clearTimer(replacedRunner.timer as NonNullable<TRunner["timer"]>);
      replacedRunner.timer = null;
    }
  }

  runners.delete(fromAccountId);
  runner.accountId = toAccountId;
  runner.timer = null;
  runners.set(toAccountId, runner);

  if (!runner.running) {
    dependencies.schedule(runner);
  }
  return { transferredRunner: runner, replacedRunner };
}
