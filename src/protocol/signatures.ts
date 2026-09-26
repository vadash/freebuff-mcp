// Issue #28: every known screen is declared once as a Screen signature — its Markers
// (each strong or weak), a threshold (N of M, at least one strong), and the region of
// the Screen the Markers are searched in — and one pure function recognizes the Screen
// text against the table. Markers match case-insensitively and whitespace-tolerantly,
// so one reworded space or case change is not Drift. When two signatures match, the
// table's order is the fixed priority: Session-in-use dialog > login gate > connecting
// > Continue > Model picker > ready. Thresholds, regions and strong/weak labels are
// tuned against the fixture corpus (`tests/corpus.test.ts`), the acceptance bar.
import { CONNECTING_REGEX, CONTINUE_PROMPT, COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, LOGIN_REQUIRED, PICKER_TITLE, PRICE_REGEX, READY_PROMPT, SESSION_ENDED, SINGLE_INSTANCE_MARKERS } from './markers.ts';

export type KnownScreen = 'Model picker' | 'ready' | 'Continue' | 'Session-in-use dialog' | 'login gate' | 'connecting';

/** pass: every Marker present; degraded: threshold met, some Marker missing (Drift has
 *  started, the missing Markers are named); fail: below threshold. */
export type RecognitionLevel = 'pass' | 'degraded' | 'fail';

export interface Recognition {
  /** The recognized screen; `'blank'` is a paint transition (known, but no screen);
   *  null when the Screen matches no known screen. */
  screen: KnownScreen | 'blank' | null;
  level: RecognitionLevel;
  /** Names of the recognized screen's Markers absent from its region; empty unless degraded. */
  missing: string[];
}

interface Marker {
  name: string;
  pattern: RegExp;
  /** Weak Markers (generic wording, e.g. a button label) never recognize a screen by
   *  themselves: a threshold met without a strong Marker recognizes nothing. */
  strong: boolean;
}

interface ScreenSignature {
  screen: KnownScreen;
  /** The Marker search region: the bottom N rows of the rendered content for the
   *  bottom-anchored screens (dialogs, Continue, ready — their wording never sits in
   *  the transcript above), or 'all' for the Model picker, login gate and connecting
   *  status line. */
  bottomRows: number | 'all';
  threshold: number;
  markers: Marker[];
}

// The bottom `count` rows of the rendered content: the blank padding the viewport
// leaves below the last painted row (real captures fill the height, hand-made vectors
// do not) is never part of a screen's bottom.
const bottomRegion = (text: string, count: number): string => {
  const rows = text.split('\n');
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? '').trim() === '') end -= 1;
  return rows.slice(Math.max(0, end - count), end).join('\n');
};

// Escapes wording for a literal match; words may be separated by any whitespace run,
// including the row wrap a narrow terminal produces inside a phrase.
const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tolerant = (wordings: string[]): RegExp =>
  new RegExp(`(?:${wordings.map((wording) => wording.trim().split(/\s+/).map(escapeWord).join('\\s+')).join('|')})`, 'i');

// Priority order. The Session-in-use dialog renders over the Model picker (sharing its
// `H · History` hint row) and connecting renders over the ready input box, so the
// overlaid screen always wins; ready, the least specific, is last.
const SIGNATURES: ScreenSignature[] = [
  {
    screen: 'Session-in-use dialog',
    bottomRows: 20,
    threshold: 1,
    markers: [
      // Both captured wordings: 0.0.198+ says 'Session already in use', 0.0.193 said
      // 'Only one freebuff instance is allowed at a time.' (session-in-use / single-instance).
      { name: 'SINGLE_INSTANCE_MARKERS', pattern: tolerant(SINGLE_INSTANCE_MARKERS), strong: true },
      { name: 'TAKE_OVER', pattern: tolerant(['Take over']), strong: false },
    ],
  },
  {
    screen: 'login gate',
    bottomRows: 'all',
    threshold: 1,
    markers: [{ name: 'LOGIN_REQUIRED', pattern: tolerant([LOGIN_REQUIRED]), strong: true }],
  },
  {
    screen: 'connecting',
    bottomRows: 6,
    threshold: 1,
    // Whole-word, mirroring the classifier: `Connecting...` on the connecting status
    // line, never a transcript's unrelated 'Connecting' (issue #22).
    markers: [{ name: 'CONNECTING_REGEX', pattern: CONNECTING_REGEX, strong: true }],
  },
  {
    screen: 'Continue',
    bottomRows: 8,
    threshold: 2,
    markers: [
      { name: 'SESSION_ENDED', pattern: tolerant([SESSION_ENDED]), strong: true },
      { name: 'CONTINUE_PROMPT', pattern: tolerant([CONTINUE_PROMPT]), strong: true },
    ],
  },
  {
    screen: 'Model picker',
    bottomRows: 'all',
    threshold: 1,
    markers: [
      { name: 'PICKER_TITLE', pattern: tolerant([PICKER_TITLE]), strong: true },
      { name: 'PRICE_REGEX', pattern: PRICE_REGEX, strong: false },
      { name: 'FREEBUCKS_BALANCE_REGEX', pattern: FREEBUCKS_BALANCE_REGEX, strong: false },
    ],
  },
  {
    screen: 'ready',
    bottomRows: 6,
    threshold: 1,
    markers: [
      { name: 'READY_PROMPT', pattern: tolerant([READY_PROMPT]), strong: true },
      { name: 'COUNTDOWN_REGEX', pattern: COUNTDOWN_REGEX, strong: false },
    ],
  },
];

/** Recognizes the flattened Screen text against the signature table. A blank frame is a
 *  paint transition (ConPTY emits transient blanks between repaints), also known but no
 *  screen — the one place that rule lives. Anything unrecognized is unknown (issue #21)
 *  and gets dumped by the Driver's settle loop. */
export const recognizeScreen = (text: string): Recognition => {
  if (text.trim() === '') return { screen: 'blank', level: 'pass', missing: [] };
  for (const signature of SIGNATURES) {
    const region = signature.bottomRows === 'all' ? text : bottomRegion(text, signature.bottomRows);
    const missing = signature.markers.filter((marker) => !marker.pattern.test(region)).map((marker) => marker.name);
    const matched = signature.markers.length - missing.length;
    const strongMatched = signature.markers.some((marker) => marker.strong && !missing.includes(marker.name));
    if (matched >= signature.threshold && strongMatched) {
      return { screen: signature.screen, level: missing.length === 0 ? 'pass' : 'degraded', missing };
    }
  }
  return { screen: null, level: 'fail', missing: [] };
};
