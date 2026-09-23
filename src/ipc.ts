import { connect, type Socket } from 'node:net';

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export const pipeReachable = (pipeName: string, timeoutMs: number): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(pipeName);
  const finish = (reachable: boolean): void => {
    clearTimeout(timer);
    socket.destroy();
    resolve(reachable);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  return promise;
};

export const waitForPipe = async (pipeName: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pipeReachable(pipeName, 250)) return;
    if (Date.now() > deadline) throw new Error(`pipe ${pipeName} never became reachable within ${timeoutMs}ms`);
    await sleep(100);
  }
};

const openPipe = (pipeName: string, timeoutMs = 5_000): Promise<Socket> => {
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  const socket = connect(pipeName);
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error(`pipe ${pipeName} not reachable within ${timeoutMs}ms`));
  }, timeoutMs);
  socket.once('connect', () => {
    clearTimeout(timer);
    resolve(socket);
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  return promise;
};

const firstLine = (socket: Socket, timeoutMs: number, action: (socket: Socket) => void): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buffer = '';
  socket.setEncoding('utf8');
  const timer = setTimeout(() => reject(new Error(`pipe response timed out after ${timeoutMs}ms`)), timeoutMs);
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const nl = buffer.indexOf('\n');
    if (nl === -1) return;
    clearTimeout(timer);
    resolve(buffer.slice(0, nl));
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  action(socket);
  return promise;
};

export const requestPipe = async <T>(pipeName: string, request: unknown, timeoutMs = 30_000): Promise<T> => {
  const socket = await openPipe(pipeName);
  try {
    return JSON.parse(await firstLine(socket, timeoutMs, (s) => s.write(JSON.stringify(request) + '\n'))) as T;
  } finally {
    socket.destroy();
  }
};

export const sendRawLine = async (pipeName: string, line: string, timeoutMs = 5_000): Promise<string> => {
  const socket = await openPipe(pipeName);
  try {
    return await firstLine(socket, timeoutMs, (s) => s.write(line + '\n'));
  } finally {
    socket.destroy();
  }
};
