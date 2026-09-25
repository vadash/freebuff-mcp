import {
  CONTINUE_PROMPT,
  COUNTDOWN_REGEX,
  FREEBUCKS_BALANCE_REGEX,
  FREEBUCKS_LEFT_REGEX,
  PICKER_TITLE,
  PRICE_REGEX,
  READY_PROMPT,
  SESSION_ENDED,
} from './protocol/markers.ts';

type Marker = [name: string, pattern: string | RegExp];

type IdleScreen = 'Model picker' | 'ready' | 'Continue';

// The Markers each idle screen renders. A screen is recognised when any of its Markers
// is on the Screen; every Marker of a recognised screen must then be present. Recognition
// deliberately avoids classifyScreen: that relies on the very Markers being checked.
const SCREEN_MARKERS: Record<IdleScreen, Marker[]> = {
  'Model picker': [
    ['PICKER_TITLE', PICKER_TITLE],
    ['PRICE_REGEX', PRICE_REGEX],
    ['FREEBUCKS_BALANCE_REGEX', FREEBUCKS_BALANCE_REGEX],
  ],
  ready: [
    ['READY_PROMPT', READY_PROMPT],
    ['COUNTDOWN_REGEX', COUNTDOWN_REGEX],
  ],
  Continue: [
    ['SESSION_ENDED', SESSION_ENDED],
    ['CONTINUE_PROMPT', CONTINUE_PROMPT],
    ['FREEBUCKS_LEFT_REGEX', FREEBUCKS_LEFT_REGEX],
  ],
};

const present = (text: string, pattern: string | RegExp): boolean =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

/** Failures naming each Marker missing or drifted from the live Screen text. */
export const checkMarkers = (text: string): string[] => {
  const failures: string[] = [];
  let recognised = false;
  for (const [screen, markers] of Object.entries(SCREEN_MARKERS)) {
    if (!markers.some(([, pattern]) => present(text, pattern))) continue;
    recognised = true;
    for (const [name, pattern] of markers) {
      if (!present(text, pattern)) failures.push(`${name}: missing from the ${screen} Screen (expected ${String(pattern)})`);
    }
  }
  if (!recognised) {
    const names = Object.values(SCREEN_MARKERS).flat().map(([name]) => name).join(', ');
    failures.push(`Screen matches no known screen: none of ${names} found`);
  }
  return failures;
};
