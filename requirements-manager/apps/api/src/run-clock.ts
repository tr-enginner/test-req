import {Prisma, type PrismaClient} from "@prisma/client";

type RunTime = {accumulatedElapsedMs: bigint | number; attemptStartedAt: Date | null};

export function withElapsed<T extends RunTime>(run: T, now: Date): Omit<T, "accumulatedElapsedMs" | "attemptStartedAt"> & {elapsedMs: number} {
    const {accumulatedElapsedMs, attemptStartedAt, ...visible} = run;
    const accumulated = Number(accumulatedElapsedMs), active = attemptStartedAt ? now.getTime() - attemptStartedAt.getTime() : 0;
    const duration = accumulated + Math.max(0, active);
    return {...visible, elapsedMs: Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0}
}

// The clock and run rows belong to one database snapshot, regardless of host clocks.
export function readWithRunClock<T>(db: PrismaClient,
    read: (tx: Prisma.TransactionClient, now: Date) => Promise<T>): Promise<T> {
    return db.$transaction(async tx => {
        const [clock] = await tx.$queryRaw<{now: Date}[]>`SELECT statement_timestamp() AT TIME ZONE 'UTC' AS now`;
        return read(tx, clock.now)
    }, {isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead})
}
