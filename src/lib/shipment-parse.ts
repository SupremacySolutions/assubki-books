/**
 * Reading a supplier's shipment list.
 *
 * The list arrives as a message - one book a line, in Arabic or Urdu, with the
 * volumes, the price and how many copies are coming. It is written by a person
 * rather than a machine, so the separators wander, the digits are sometimes
 * Arabic-Indic, and a field is missing whenever it did not apply.
 *
 * Nothing here touches the DOM or the database, so it can be run against the
 * real list from a script and checked line by line. That matters more than
 * usual: this is the one place where a quiet mistake becomes forty listings
 * with the wrong price.
 *
 * The rule throughout is that a line is never silently dropped and never
 * silently guessed at. Anything it cannot read comes back with `problems` set
 * and its raw text intact, for the owner to finish by hand in the preview.
 */

export type Script = 'arabic' | 'urdu' | 'english';

export interface ParsedLine {
  /** Exactly what was pasted, so the preview can show it when parsing failed. */
  raw: string;
  /** The supplier's own numbering, which is ordering rather than data. */
  index: number | null;
  title: string;
  script: Script;
  volumes: number | null;
  pricePence: number | null;
  stock: number | null;
  /** Edition wording lifted out of the title so it does not pollute a search. */
  note: string | null;
  /** Anything that classified as nothing. Shown, never discarded. */
  leftovers: string[];
  problems: string[];
}

/*
 * Digits. Arabic-Indic for Arabic, Extended Arabic-Indic for Urdu - and it is
 * the Extended set that Urdu pastes actually use, so both have to be mapped or
 * a volume count silently disappears.
 */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Invisible characters that survive a copy-paste and break every match. */
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿­ـ]/g;

/** Every dash a person might type, plus the bullets used as separators. */
const SEPARATORS = /\s*(?:[–—―|·•]|(?<=\s)-(?=\s))\s*/g;

/**
 * Words meaning "volumes", in both languages.
 *
 * Matched against a diacritic-stripped copy, so `مجلدًا` and `مجلّد` both reduce
 * to `مجلد` and one entry covers every inflection.
 */
const VOLUME_WORDS = [
  'مجلدات', 'مجلد', 'اجزاء', 'أجزاء', 'جزء', 'جلدیں', 'جلد', 'حصے', 'حصہ',
  'volumes', 'volume', 'vols', 'vol',
];

/**
 * Edition wording worth lifting out of the title.
 *
 * Only tokens that cannot be part of a book's name. `DELUXE` is a printer's
 * label and never a word in a title; `جديد` looks like one but means "modern"
 * and belongs to the title of at least three books on this list - stripping it
 * turned "Islam and modern economic issues" into "Islam and economic issues".
 * A note is a convenience, a mangled title is a wrong listing, so anything
 * ambiguous stays where the supplier put it.
 */
const NOTES = [{ match: /\bdeluxe\b|\bdlx\b|ديلوكس|ڈیلکس/iu, label: 'Deluxe' }];

/**
 * Letters that exist in Urdu and effectively never in Arabic.
 *
 * `ی` and `ے` are the strongest signals - an Arabic text does not contain
 * them - so a title carrying either is Urdu however much Arabic-looking script
 * surrounds it.
 */
const URDU_ONLY = /[ٹڈڑںھہۂۃیےگچپژ]/u;
const ANY_ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u;

/** Combining marks, so an inflected word matches its own stem. */
const DIACRITICS = /[ً-ْٰٓ-ٕ]/g;

/** Arabic-Indic digits to ASCII, and Arabic numeric punctuation with them. */
function normaliseDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(ARABIC_INDIC.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String(EXTENDED_INDIC.indexOf(c)))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

/**
 * One line, reduced to something with predictable separators.
 *
 * A hyphen only counts as a separator when it has space on both sides, or
 * `al-Hidayah` and `1-2` would be torn in half.
 */
function tidy(line: string): string {
  return normaliseDigits(line)
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[  -​]/g, ' ')
    .replace(SEPARATORS, '|')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const stem = (text: string) => text.replace(DIACRITICS, '');

/** A part that names a price, in pence. */
function readPrice(part: string): number | null {
  const found = part.match(
    /(?:£|\$|\bgbp\b)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:£|\$|\bgbp\b)/i,
  );
  if (!found) return null;
  const amount = Number.parseFloat((found[1] ?? found[2]).replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** A part that names a number of volumes, in either word order. */
function readVolumes(part: string): number | null {
  const flat = stem(part).toLowerCase();
  for (const word of VOLUME_WORDS) {
    const after = flat.match(new RegExp(`(\\d{1,3})\\s*${word}`, 'u'));
    const before = flat.match(new RegExp(`${word}\\s*(\\d{1,3})`, 'u'));
    const n = Number(after?.[1] ?? before?.[1]);
    // One volume is not a set, matching what `volumes` means everywhere else.
    if (Number.isInteger(n) && n > 1 && n <= 200) return n;
  }
  return null;
}

/** Which script the title is in, which decides `title_ar` against `title_ur`. */
export function scriptOf(title: string): Script {
  if (!ANY_ARABIC_SCRIPT.test(title)) return 'english';
  return URDU_ONLY.test(title) ? 'urdu' : 'arabic';
}

/**
 * One line of the list.
 *
 * Classified by what each part looks like rather than by where it sits, because
 * the owner leaves a field out whenever it does not apply and everything after
 * it would shift. The exception is the stock count, which is a bare number and
 * therefore only tellable from its position: it follows the price.
 */
export function parseLine(raw: string, fallbackIndex: number): ParsedLine {
  const problems: string[] = [];
  const leftovers: string[] = [];

  let working = tidy(raw);

  const numbered = working.match(/^(\d{1,4})\s*[.)\-:]\s*/);
  const index = numbered ? Number(numbered[1]) : null;
  if (numbered) working = working.slice(numbered[0].length);
  working = working.replace(/^[-•*·]\s+/, '');

  const parts = working.split('|').map((p) => p.trim()).filter(Boolean);

  let pricePence: number | null = null;
  let volumes: number | null = null;
  let stock: number | null = null;
  let note: string | null = null;
  let priceAt = -1;
  const titleParts: string[] = [];

  parts.forEach((part, at) => {
    if (pricePence === null) {
      const price = readPrice(part);
      if (price !== null) {
        pricePence = price;
        priceAt = at;
        return;
      }
    }
    if (volumes === null) {
      const vols = readVolumes(part);
      if (vols !== null) {
        volumes = vols;
        return;
      }
    }
    // A bare number after the price is how many copies are coming. Before the
    // price it is part of the title - a number in a book's name is common.
    if (stock === null && priceAt >= 0 && at > priceAt && /^\d{1,4}$/.test(part)) {
      stock = Number(part);
      return;
    }
    titleParts.push(part);
  });

  let title = titleParts.join(' ').replace(/\s+/g, ' ').trim();

  for (const { match, label } of NOTES) {
    if (match.test(title)) {
      note = note ? `${note} · ${label}` : label;
      title = title.replace(match, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  if (!title) problems.push('no title');
  if (pricePence === null) problems.push('no price');
  /*
   * A missing count is reported, never assumed. Defaulting to one would put a
   * confident number in front of a customer that nobody ever wrote down.
   */
  if (stock === null) problems.push('no number of copies');
  if (pricePence !== null && pricePence > 1_000_00 * 10) {
    problems.push('the price looks wrong');
  }

  return {
    raw,
    index: index ?? fallbackIndex,
    title,
    script: scriptOf(title),
    volumes,
    pricePence,
    stock,
    note,
    leftovers,
    problems,
  };
}

/**
 * The whole pasted message.
 *
 * The first line is usually the shipment's own heading rather than a book, and
 * trailing prose is usually the note about how long reservations are held; both
 * are left for the caller to lift out, because guessing wrong would silently
 * lose a book. Every non-blank line comes back.
 */
export function parseShipment(text: string): ParsedLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => parseLine(line, i + 1));
}

/** Whether a row is complete enough to be offered to a customer. */
export function readable(line: ParsedLine): boolean {
  return line.problems.length === 0;
}
