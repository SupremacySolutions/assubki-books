/**
 * Shelf classmarks.
 *
 * Customers here navigate by discipline, not by mood — 105 of the 226 titles
 * are syllabus texts. So a category is shown as a short code drawn from the
 * discipline's own Arabic name (naḥw, taṣawwuf, rijāl) rather than an English
 * abbreviation. It tells a madrasah student where a book sits in their course
 * at a glance, and it is the one structural device on the page that carries
 * real information.
 */

const CLASSMARKS: Record<string, string> = {
  aqeedah: 'AQD',                            // ʿaqīdah — creed
  'arabic-grammar': 'NHW',                   // naḥw — syntax
  children: 'ATF',                           // aṭfāl — children
  'contemporary-issues': 'MSR',              // muʿāṣir — contemporary
  'dars-nizami': 'DNZ',                      // dars-i niẓāmī
  'duas-supplication-compilations': 'DUA',   // duʿāʾ
  fiqh: 'FQH',                               // fiqh — jurisprudence
  hadith: 'HDT',                             // ḥadīth
  'hadith-commentaries': 'SHR',              // sharḥ — commentary
  'hadith-narrators': 'RJL',                 // rijāl — narrator criticism
  'hadith-works': 'MTN',                     // matn — primary text
  hanafi: 'HNF',
  history: 'TRK',                            // tārīkh
  logic: 'MNT',                              // manṭiq
  maktab: 'MKT',                             // maktab
  mushaf: 'MSF',                             // muṣḥaf
  quran: 'QRN',                              // qurʾān
  seerah: 'SRH',                             // sīrah
  shafi: 'SHF',
  spirituality: 'TSW',                       // taṣawwuf
  stories: 'QSS',                            // qiṣaṣ — stories
  syllabus: 'SYL',
  tafsir: 'TFS',                             // tafsīr
  'tarajim-biographies': 'TRJ',              // tarājim — biographies
  'ulum-al-hadith': 'ULM',                   // ʿulūm al-ḥadīth
  uncategorised: 'GEN',
};

export function classmark(slug: string): string {
  return CLASSMARKS[slug] ?? slug.slice(0, 3).toUpperCase();
}
