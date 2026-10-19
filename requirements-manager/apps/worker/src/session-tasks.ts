/** Observe both tasks immediately, including failures before the command finishes. */
export async function runSessionTasks(consume: () => Promise<void>, command: () => Promise<unknown>) {
    await Promise.all([Promise.resolve().then(consume), Promise.resolve().then(command)]);
}
