// Shared helpers; each behaviour has exactly one home (issue #10).
/// <reference lib="es2024" />

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve: wake } = Promise.withResolvers<void>();
  setTimeout(wake, ms);
  return promise;
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
