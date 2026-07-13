export function ignorePromise<T>(_promise: Promise<T>): void {
  // Intentionally fire-and-forget; caller does not await this promise.
}
