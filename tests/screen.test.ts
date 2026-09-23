import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliTerminalScreen, classifyScreen, flattenScreen } from '../src/protocol/screen.ts';

const dir = new URL('./fixtures/screen/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
const screen = async (name: string): Promise<string> => flattenScreen([load(name)]);

describe('classifyScreen', () => {
  it('reports a ready prompt', async () => {
    expect(classifyScreen(await screen('ready.ansi'))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('reports the connecting spinner even when the prompt is rendered below', async () => {
    expect(classifyScreen(await screen('connecting.ansi'))).toEqual({ ready: false, connecting: true, picker: null, banner: null });
  });

  it('becomes ready when the cursor-up rewrite erases Connecting', async () => {
    expect(classifyScreen(await screen('connecting-to-ready.ansi'))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('binds a directory banner only for the expected dir', async () => {
    const text = await screen('banner-ready.ansi');
    expect(classifyScreen(text, 'C:/work/demo-app')).toEqual({ ready: true, connecting: false, picker: null, banner: 'C:/work/demo-app' });
    expect(classifyScreen(text)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
    expect(classifyScreen(text, 'C:/elsewhere')).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('sees an expanded model picker', async () => {
    expect(classifyScreen(await screen('picker-expanded.ansi'))).toEqual({ ready: false, connecting: false, picker: 'expanded', banner: null });
  });

  it('sees a collapsed model picker', async () => {
    expect(classifyScreen(await screen('picker-collapsed.ansi'))).toEqual({ ready: false, connecting: false, picker: 'collapsed', banner: null });
  });
});

describe('flattenScreen', () => {
  it('renders chunks through one shared screen', async () => {
    expect(classifyScreen(await flattenScreen([load('ready.ansi')]))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('reassembles an escape sequence split mid-sequence', async () => {
    const raw = load('split-escape.ansi');
    const cut = raw.indexOf('\x1b[2J') + '\x1b[2'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(classifyScreen(flat)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
    expect(flat).toBe(await flattenScreen([raw]));
  });

  it('completes a partial line across writes', async () => {
    const raw = load('partial-line.ansi');
    const cut = raw.indexOf('Connecting') + 'Connect'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain('Connecting...');
    expect(classifyScreen(flat)).toEqual({ ready: false, connecting: true, picker: null, banner: null });
  });

  it('keeps the last repaint', async () => {
    const flat = await flattenScreen([load('repaint.ansi')]);
    expect(flat).not.toContain('Connecting');
    expect(classifyScreen(flat)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('reads the viewport, not scrollback, once output exceeds the screen', async () => {
    const screen = new CliTerminalScreen();
    for (let i = 0; i < 60; i++) screen.write(`line-${i}\r\n`);
    await screen.flush();
    const text = screen.text();
    expect(text).toContain('line-59');
    expect(text).toContain('line-13\n');
    expect(text).not.toContain('line-12\n');
    expect(text).not.toContain('line-0\n');
  });
});
