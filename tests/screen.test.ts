import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyScreen, flattenScreen } from '../src/protocol/screen.js';

const dir = new URL('./fixtures/screen/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
const screen = (name: string): string => flattenScreen([load(name)]);

describe('classifyScreen', () => {
  it('reports a ready prompt', () => {
    expect(classifyScreen(screen('ready.ansi'))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('reports the connecting spinner even when the prompt is rendered below', () => {
    expect(classifyScreen(screen('connecting.ansi'))).toEqual({ ready: false, connecting: true, picker: null, banner: null });
  });

  it('becomes ready when the cursor-up rewrite erases Connecting', () => {
    expect(classifyScreen(screen('connecting-to-ready.ansi'))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('binds a directory banner only for the expected dir', () => {
    const text = screen('banner-ready.ansi');
    expect(classifyScreen(text, 'C:/work/demo-app')).toEqual({ ready: true, connecting: false, picker: null, banner: 'C:/work/demo-app' });
    expect(classifyScreen(text)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
    expect(classifyScreen(text, 'C:/elsewhere')).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('sees an expanded model picker', () => {
    expect(classifyScreen(screen('picker-expanded.ansi'))).toEqual({ ready: false, connecting: false, picker: 'expanded', banner: null });
  });

  it('sees a collapsed model picker', () => {
    expect(classifyScreen(screen('picker-collapsed.ansi'))).toEqual({ ready: false, connecting: false, picker: 'collapsed', banner: null });
  });
});

describe('flattenScreen', () => {
  it('renders chunks through one shared screen', () => {
    expect(classifyScreen(flattenScreen([load('ready.ansi')]))).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });

  it('reassembles an escape sequence split mid-sequence', () => {
    const raw = load('split-escape.ansi');
    const cut = raw.indexOf('\x1b[2J') + '\x1b[2'.length;
    const flat = flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(classifyScreen(flat)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
    expect(flat).toBe(flattenScreen([raw]));
  });

  it('completes a partial line across writes', () => {
    const raw = load('partial-line.ansi');
    const cut = raw.indexOf('Connecting') + 'Connect'.length;
    const flat = flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain('Connecting...');
    expect(classifyScreen(flat)).toEqual({ ready: false, connecting: true, picker: null, banner: null });
  });

  it('keeps the last repaint', () => {
    const flat = flattenScreen([load('repaint.ansi')]);
    expect(flat).not.toContain('Connecting');
    expect(classifyScreen(flat)).toEqual({ ready: true, connecting: false, picker: null, banner: null });
  });
});
