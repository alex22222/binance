export async function retry(operation, {
  attempts,
  delayMs,
  shouldRetry,
  onRetry = async () => {}
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts || !shouldRetry(error)) throw error;
      await onRetry(error, attempt, attempt + 1);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs * attempt));
    }
  }
  throw new Error("Retry attempts exhausted");
}
