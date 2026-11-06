/**
 * Close spellings: the search behind the search.
 *
 * Every title in this shop is a transliteration, and there is no agreed way to
 * write one. The same book is "Aqidah Tahawiyyah", "Aqeedah Tahawiya" and
 * "Aqueedah at-Tahawiyya"; "Quduri" is "Kuduri" and "Qudoori"; "Riyadhus
 * Saliheen" is "Riyad al-Salihin". The full-text index matches the letters
 * typed, so each of those found nothing - and the search log showed that about
 * a third of the searches that "found nothing" were for books on the shelf.
 *
 * This folds both sides to a rough skeleton of how the word sounds - long
 * vowels short, digraphs to one letter, articles dropped, Arabic letter
 * variants merged - and compares skeletons. It only runs when the exact search
 * found nothing, so it can be generous without crowding out a precise answer.
 */

/** Words that say nothing about which book: articles and joining particles. */
const PARTICLES = new Set([
  'al', 'el', 'ul', 'il', 'ad', 'ar', 'as', 'ash', 'at', 'an', 'az', 'ud', 'ur', 'us', 'ut', 'un',
  'wa', 'wal', 'bi', 'li', 'lil', 'the', 'of', 'and', 'a', 'و', 'في',
]);

/** "riyadus", "nurul", "hayatus" - a word with its article glued to the end. */
const GLUED = /(.{3,})(?:ul|us|ur|ut|ud|un|ush|uz|ud|ul)$/;

/**
 * One word reduced to its rough sound.
 *
 * Order matters: digraphs before single letters, so "dh" becomes "d" before
 * "h" is considered, and doubled letters are collapsed last, after the
 * substitutions have made new pairs ("tahawiyyah" -> "tahauiiah" -> "tahauia").
 */
function foldLatin(word: string): string {
  let w = word;
  for (const [from, to] of [
    ['aa', 'a'], ['ee', 'i'], ['ii', 'i'], ['oo', 'u'], ['uu', 'u'], ['ou', 'u'],
    ['dh', 'd'], ['th', 't'], ['kh', 'k'], ['gh', 'g'], ['sh', 's'], ['zh', 'z'], ['ph', 'f'],
    ['q', 'k'], ['z', 'd'], ['e', 'i'], ['o', 'u'], ['y', 'i'], ['w', 'u'],
  ] as const) {
    w = w.split(from).join(to);
  }
  w = w.replace(/(.)\1+/g, '$1');
  // The closing "h" of "Binayah", "Tuhfah", "Kifayah" is the ta marbuta, which
  // half of all spellings leave off.
  return w.length > 3 ? w.replace(/([aiu])h$/, '$1') : w;
}

function foldArabic(word: string): string {
  let w = word
    .replace(/[ً-ٰٟـ]/g, '') // harakat, dagger alif, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ةۃ]/g, 'ه')
    .replace(/[ىیے]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[ہھ]/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
  // The definite article, alone or behind a joining letter: البناية, والكتاب.
  if (w.length > 4) w = w.replace(/^(?:[وفبكل])?ال/, '');
  else if (w.length > 3) w = w.replace(/^ال/, '');
  return w;
}

/** The words of a title or a query, each folded, particles dropped. */
export function foldWords(text: string): string[] {
  const out: string[] = [];
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const raw of words) {
    if (PARTICLES.has(raw)) continue;
    let w: string;
    if (/[؀-ۿ]/.test(raw)) {
      w = foldArabic(raw);
    } else {
      const glued = GLUED.exec(raw);
      w = foldLatin(glued && raw.length > 5 ? glued[1] : raw);
    }
    if (w && !PARTICLES.has(w)) out.push(w);
  }
  return out;
}

/**
 * Edit distance with a ceiling, counting two swapped letters as one slip -
 * "trimizi" for "tirmidhi" is one finger ahead of the other, not two mistakes.
 */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], before[j - 2] + 1);
      }
      best = Math.min(best, row[j]);
    }
    if (best > max) return false;
    before = prev;
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * How well one query word matches one title word: 3 exact, 2 the start of it,
 * 1 a slip of the keyboard, 0 not at all. Short words must match exactly or as
 * a start - "us" one letter off is half the dictionary.
 */
function wordScore(q: string, t: string): number {
  if (q === t) return 3;
  if (q.length >= 2 && t.startsWith(q)) return 2;
  if (q.length >= 4 && t.length >= 4 && q.startsWith(t)) return 2;
  // Five letters one off is a different word as often as a typo ("sawat",
  // "salat"); from six it is nearly always the same one.
  if (q.length >= 6 && within(q, t, q.length >= 9 ? 2 : 1)) return 1;
  return 0;
}

export interface Folded {
  id: number;
  words: string[];
}

/**
 * The ids that match `query`, best first.
 *
 * Every query word has to land, except that a query of four words or more may
 * drop one in three - "sahih muslim full set" is still asking for Sahih Muslim.
 * Three words must all land: dropping one of "quran made easy" leaves "made
 * easy", which is a different book. Scored by how well the words land, so an
 * exact spelling beats a near one.
 */
export function closest(query: string, index: Folded[], limit = 48): number[] {
  const q = foldWords(query);
  if (!q.length || q.join('').length < 3) return [];
  const needed = q.length <= 3 ? q.length : q.length - Math.floor(q.length / 3);

  const scored: { id: number; score: number }[] = [];
  for (const doc of index) {
    let hits = 0;
    let score = 0;
    for (const w of q) {
      let best = 0;
      for (const t of doc.words) {
        const s = wordScore(w, t);
        if (s > best) best = s;
        if (best === 3) break;
      }
      if (best) {
        hits++;
        score += best;
      }
    }
    if (hits >= needed) scored.push({ id: doc.id, score: score * 10 - doc.words.length / 10 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

/** The same skeleton as a single key, for grouping spellings of one search. */
export function foldKey(text: string): string {
  return foldWords(text).join(' ');
}
