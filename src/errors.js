export class PauseError extends Error {}
export class RetryError extends Error {}
export function retryDelay(failures, config) {
  return (config.retrySeconds[failures - 1] ?? config.recoveryIntervalSeconds) * 1000;
}
