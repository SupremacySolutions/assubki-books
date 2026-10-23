/**
 * What the front page shows under the hero, and in what order - the owner's
 * choice, made on the portal's Front page screen.
 *
 * Two things are not in the list and cannot be moved. A live sale always comes
 * straight after the hero: it is the one thing on the page with a deadline the
 * shop chose, and a sale nobody can find is worse than none. "How ordering
 * works" always closes the page. Everything between is here.
 *
 * Stored as JSON in `settings` under 'home_layout'. A shelf row names its shelf
 * by id rather than path, so renaming or moving a shelf keeps its place on the
 * front page instead of quietly dropping it.
 */

export type FixedSection = 'new' | 'arriving' | 'shelves';
export type SectionId = FixedSection | `shelf:${number}`;

export interface HomeSection {
  id: SectionId;
  show: boolean;
}

/** The sections that always exist, whether or not they are switched on. */
export const FIXED_SECTIONS: { id: FixedSection; label: string; about: string }[] = [
  {
    id: 'new',
    label: 'New releases',
    about: 'The newest listings with a cover and copies on the shelf.',
  },
  {
    id: 'arriving',
    label: 'Arriving soon',
    about: 'Books on an incoming shipment. Hidden by itself when nothing is on the way.',
  },
  {
    id: 'shelves',
    label: 'Browse the shelves',
    about: 'The index of subjects, with how many titles each holds.',
  },
];

/**
 * The page before the owner has touched it.
 *
 * New releases first, then what was there before: arriving, the shelf index,
 * and the three shelves a madrasah student shops from. Shelves are named by
 * path here because ids differ between databases; `parseLayout` resolves them.
 */
const DEFAULT_ORDER: (FixedSection | { path: string })[] = [
  'new',
  'arriving',
  'shelves',
  { path: 'syllabus' },
  { path: 'hadith' },
  { path: 'fiqh' },
];

export const shelfSection = (id: number): SectionId => `shelf:${id}`;

export function shelfIdOf(id: SectionId): number | null {
  const m = /^shelf:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * The saved layout, made safe to render.
 *
 * Whatever is stored, the result names each fixed section exactly once and
 * only shelves that still exist, each once. A fixed section missing from a
 * saved layout - one added to the code after the owner last saved - is put at
 * the end, switched on, rather than vanishing. Nothing saved, or something
 * unreadable, gives the default.
 */
export function parseLayout(raw: string | null | undefined, shelves: { id: number; path: string }[]): HomeSection[] {
  const known = new Set(shelves.map((s) => s.id));
  const out: HomeSection[] = [];
  const seen = new Set<string>();
  const add = (id: SectionId, show: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, show });
  };

  let saved: unknown = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, show } = entry as { id?: unknown; show?: unknown };
      if (typeof id !== 'string') continue;
      const shelf = shelfIdOf(id as SectionId);
      if (shelf !== null ? known.has(shelf) : FIXED_SECTIONS.some((f) => f.id === id)) {
        add(id as SectionId, show !== false);
      }
    }
  } else {
    const byPath = new Map(shelves.map((s) => [s.path, s.id]));
    for (const item of DEFAULT_ORDER) {
      if (typeof item === 'string') add(item, true);
      else {
        const id = byPath.get(item.path);
        if (id !== undefined) add(shelfSection(id), true);
      }
    }
  }

  for (const f of FIXED_SECTIONS) add(f.id, true);
  return out;
}
