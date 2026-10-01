// Issue #28: every known screen is declared once as a Screen signature — its Markers
// (each strong or weak), a threshold (N of M, at least one strong), and the region of
// the Screen the Markers are searched in — and one pure function recognizes the Screen
// text against the table. Markers match case-insensitively and whitespace-tolerantly,
// so one reworded space or case change is not Drift. When two signatures match, the
// table's order is the fixed priority: Session-in-use dialog > login gate > connecting
// > holding banner > Continue > Welcome screen > working > ready. Thresholds, regions
// and strong/weak labels are tuned against the fixture corpus (`tests/corpus.test.ts`),
// the acceptance bar.
import { CONNECTING_REGEX, CONTINUE_PROMPT, COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, HOLDING_BANNER, LOGIN_REQUIRED, READY_PROMPT, SINGLE_INSTANCE_MARKERS, WELCOME_BOX, WORKING_TICKER_REGEX } from './markers.ts';

export type KnownScreen = 'Welcome screen' | 'ready' | 'Continue' | 'Session-in-use dialog' | 'login gate' | 'connecting' | 'working' | 'holding banner';

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
   *  the transcript above), or 'all' for the Welcome screen, login gate and connecting
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
const escapeWord = (word: string): string => word.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
const tolerant = (wordings: string[]): RegExp =>
  new RegExp(`(?:${wordings.map((wording) => wording.trim().split(/\s+/).map(escapeWord).join('\\s+')).join('|')})`, 'i');

// Regex-sourced Markers keep the parser's strict regexes strict: as Markers they match
// case-insensitively and whitespace-tolerantly (a literal space accepts any whitespace
// run), so one reworded case or row wrap is not Drift. Weak Markers alone still
// recognize nothing (the strong-Marker gate).
const marker = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source.replace(/ /g, '\\s+'), pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`);

// Priority order. The Session-in-use dialog renders over the idle screens (sharing the
// `H · History` hint row) and connecting renders over the ready input box, so the
// overlaid screen always wins. The Welcome screen comes before ready: both carry the
// ready input box, and only the Welcome screen carries its info-box line — while the
// Countdown stays a weak Marker, so a drifted wording degrades ready instead of
// failing it (issue #31).
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
    // Issue #34: the holding banner overlays the settled screen while the CLI
    // holds queued input until it rejoins; it clears on its own. It outranks the screen
    // beneath it because the Driver must wait it out before typing `/new` — a keystroke
    // typed into the banner merges with the following paste into one command line.
    screen: 'holding banner',
    bottomRows: 12,
    threshold: 1,
    markers: [{ name: 'HOLDING_BANNER', pattern: tolerant([HOLDING_BANNER]), strong: true }],
  },
  {
    // Single strong Marker: 0.1.0 replaced `Session ended` with a credits summary, so
    // the prompt tail is the one literal both generations share. `Press Enter to
    // continue` appears nowhere else (issue #22 analysis).
    screen: 'Continue',
    bottomRows: 8,
    threshold: 1,
    markers: [{ name: 'CONTINUE_PROMPT', pattern: tolerant([CONTINUE_PROMPT]), strong: true }],
  },
  {
    // WELCOME_BOX alone: 0.1.2 dropped the `n/n Freebucks remaining` line from the
    // Welcome box, so the balance cannot be a Marker here. The parse still reads it
    // (screen.ts) wherever the line exists — the session screen keeps it.
    screen: 'Welcome screen',
    bottomRows: 'all',
    threshold: 1,
    markers: [{ name: 'WELCOME_BOX', pattern: tolerant([WELCOME_BOX]), strong: true }],
  },
  {
    // Issue #34: the mid-Turn Screen — the ready layout plus the elapsed ticker above
    // the input box. It outranks ready because a working frame still shows the input
    // box; the ticker is the strong Marker, the ready prompt a weak one, so a drifted
    // input box degrades working instead of failing it.
    screen: 'working',
    bottomRows: 12,
    threshold: 1,
    markers: [
      { name: 'WORKING_TICKER_REGEX', pattern: marker(WORKING_TICKER_REGEX), strong: true },
      { name: 'READY_PROMPT', pattern: tolerant([READY_PROMPT]), strong: false },
    ],
  },
  {
    screen: 'ready',
    // The 0.1.0 layout renders two footer lines below the input box (model footer and
    // the history hint), so the Countdown sits 8 rows up, not 6.
    bottomRows: 8,
    threshold: 1,
    markers: [
      { name: 'READY_PROMPT', pattern: tolerant([READY_PROMPT]), strong: true },
      { name: 'COUNTDOWN_REGEX', pattern: marker(COUNTDOWN_REGEX), strong: false },
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
