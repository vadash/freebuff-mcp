import { connect, type Socket } from 'node:net';
import { PIPE_CONNECT_TIMEOUT_MS, PIPE_POLL_MS, PIPE_PROBE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './config.ts';
import { sleep } from './util.ts';

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
    if (await pipeReachable(pipeName, PIPE_PROBE_TIMEOUT_MS)) return;
    if (Date.now() > deadline) throw new Error(`pipe ${pipeName} never became reachable within ${timeoutMs}ms`);
    await sleep(PIPE_POLL_MS);
  }
};

const openPipe = (pipeName: string, timeoutMs = PIPE_CONNECT_TIMEOUT_MS): Promise<Socket> => {
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

export const requestPipe = async <T>(pipeName: string, request: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
  const socket = await openPipe(pipeName);
  try {
    return JSON.parse(await firstLine(socket, timeoutMs, (s) => s.write(JSON.stringify(request) + '\n'))) as T;
  } finally {
    socket.destroy();
  }
};

export const sendRawLine = async (pipeName: string, line: string, timeoutMs = PIPE_CONNECT_TIMEOUT_MS): Promise<string> => {
  const socket = await openPipe(pipeName);
  try {
    return await firstLine(socket, timeoutMs, (s) => s.write(line + '\n'));
  } finally {
    socket.destroy();
  }
};
