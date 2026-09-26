import {
  CONNECTING_REGEX,
  CONTINUE_PROMPT,
  COUNTDOWN_REGEX,
  FREEBUCKS_BALANCE_REGEX,
  FREEBUCKS_LEFT_REGEX,
  HISTORY_HINT,
  LOGIN_REQUIRED,
  PICKER_TITLE,
  PRICE_REGEX,
  READY_PROMPT,
  SESSION_ENDED,
  mentionsSingleInstance,
} from './protocol/markers.ts';

type MarkerPattern = string | RegExp | ((text: string) => boolean);
// `recognizes: false`: the Marker is expected once the screen is recognised, but it never
// recognises the screen by itself. The picker's hint row also renders under the
// Session-in-use dialog, so the hint alone must not make a dialog read as a picker.
type Marker = [name: string, pattern: MarkerPattern, recognizes?: boolean];

type IdleScreen = 'Model picker' | 'ready' | 'Continue' | 'Session-in-use dialog' | 'login gate' | 'connecting';

interface ScreenEntry {
  markers: Marker[];
  /** Recognition gate for screens sharing Markers with another state: the connecting
   *  Screen renders the ready input box underneath its status line, so while Connecting
   *  shows, the Screen is not a ready Screen and its Countdown is not expected. */
  unless?: (text: string) => boolean;
}

// The Markers each idle screen renders. A screen is recognised when any of its Markers
// is on the Screen; every Marker of a recognised screen must then be present. Recognition
// deliberately avoids classifyScreen: that relies on the very Markers being checked.
const SCREEN_MARKERS: Record<IdleScreen, ScreenEntry> = {
  'Model picker': { markers: [
    ['PICKER_TITLE', PICKER_TITLE],
    ['PRICE_REGEX', PRICE_REGEX],
    ['FREEBUCKS_BALANCE_REGEX', FREEBUCKS_BALANCE_REGEX],
    ['HISTORY_HINT', HISTORY_HINT, false],
  ] },
  ready: { markers: [
    ['READY_PROMPT', READY_PROMPT],
    ['COUNTDOWN_REGEX', COUNTDOWN_REGEX],
  ], unless: (text) => CONNECTING_REGEX.test(text) },
  Continue: { markers: [
    ['SESSION_ENDED', SESSION_ENDED],
    ['CONTINUE_PROMPT', CONTINUE_PROMPT],
    ['FREEBUCKS_LEFT_REGEX', FREEBUCKS_LEFT_REGEX],
  ] },
  'Session-in-use dialog': { markers: [['SINGLE_INSTANCE_MARKERS', mentionsSingleInstance]] },
  'login gate': { markers: [['LOGIN_REQUIRED', LOGIN_REQUIRED]] },
  connecting: { markers: [['CONNECTING_REGEX', CONNECTING_REGEX]] },
};

const present = (text: string, pattern: MarkerPattern): boolean =>
  typeof pattern === 'string' ? text.includes(pattern) : typeof pattern === 'function' ? pattern(text) : pattern.test(text);

/** Failures naming each Marker missing or drifted from the live Screen text. */
export const checkMarkers = (text: string): string[] => {
  const failures: string[] = [];
  let recognised = false;
  for (const [screen, entry] of Object.entries(SCREEN_MARKERS)) {
    if (entry.unless !== undefined && entry.unless(text)) continue;
    if (!entry.markers.some(([, pattern, recognizes = true]) => recognizes && present(text, pattern))) continue;
    recognised = true;
    for (const [name, pattern] of entry.markers) {
      if (!present(text, pattern)) failures.push(`${name}: missing from the ${screen} Screen (expected ${String(pattern)})`);
    }
  }
  if (!recognised) {
    const names = Object.values(SCREEN_MARKERS).flatMap((entry) => entry.markers).map(([name]) => name).join(', ');
    failures.push(`Screen matches no known screen: none of ${names} found`);
  }
  return failures;
};
