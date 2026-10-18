/** Preserve cancellation from both the caller and the detached execution host. */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.length < 2) return active[0];
	return AbortSignal.any(active);
}
