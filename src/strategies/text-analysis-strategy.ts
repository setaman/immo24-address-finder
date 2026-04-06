// Text analysis strategy — extract German street name candidates from listing text

export interface StreetCandidate {
  name: string;
  score: number;
  source: 'title' | 'location' | 'description';
}

// Common German street suffixes
const STREET_SUFFIXES = [
  'straße', 'strasse', 'str\\.', 'weg', 'allee', 'platz', 'ring',
  'gasse', 'damm', 'ufer', 'steig', 'pfad', 'chaussee', 'promenade',
  'brücke', 'bruecke', 'berg', 'hof', 'anger', 'markt', 'zeile',
  'stieg', 'kamp', 'bogen', 'grund', 'horst', 'heide', 'aue',
  'graben', 'garten',
];

// German address prefixes that start street names
const STREET_PREFIXES = [
  'Am', 'An der', 'An den', 'Auf der', 'Auf dem', 'Auf den',
  'Im', 'In der', 'In den', 'Zum', 'Zur',
  'Unter der', 'Unter den', 'Über der', 'Hinter der', 'Hinter dem',
  'Vor dem', 'Vor der', 'Bei der', 'Bei dem',
];

// False positives — common words that match patterns but aren't street names
const FALSE_POSITIVES = new Set([
  'neubaufeld', 'spielplatz', 'marktplatz', 'parkplatz', 'bahnhof',
  'flughafen', 'rathaus', 'sportplatz', 'friedhof', 'schulweg',
  'kindergarten', 'autobahn', 'bundesstraße', 'bundesstrasse',
  'landstraße', 'landstrasse', 'hauptstraße', 'hauptstrasse',
  'feldweg', 'waldweg', 'radweg', 'gehweg', 'fußweg', 'fussweg',
]);

/**
 * Extract street name candidates from listing text.
 * Searches title, location text, and description with different confidence weights.
 */
export function extractStreetCandidates(
  title: string | null,
  description: string | null,
  locationText: string | null,
): StreetCandidate[] {
  const candidates: StreetCandidate[] = [];
  const seen = new Set<string>();

  function addCandidate(name: string, baseScore: number, source: StreetCandidate['source']) {
    const normalized = name.trim();
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    if (FALSE_POSITIVES.has(key)) return;
    if (normalized.length < 4 || normalized.length > 60) return;
    seen.add(key);
    candidates.push({ name: normalized, score: baseScore, source });
  }

  // Score multipliers by source
  const sources: Array<{ text: string | null; source: StreetCandidate['source']; multiplier: number }> = [
    { text: title, source: 'title', multiplier: 1.5 },
    { text: locationText, source: 'location', multiplier: 1.2 },
    { text: description, source: 'description', multiplier: 1.0 },
  ];

  for (const { text, source, multiplier } of sources) {
    if (!text) continue;

    // Pattern 1: Street suffix patterns (e.g., "Musterstraße 12", "Am Musterweg")
    const suffixPattern = new RegExp(
      `(?:^|[\\s,;(])([A-ZÄÖÜ][a-zäöüß]+(?:[\\s-][A-ZÄÖÜ]?[a-zäöüß]+)*(?:${STREET_SUFFIXES.join('|')}))(?:\\s+\\d+[a-zA-Z]?)?(?=[\\s,;).]|$)`,
      'gm'
    );
    let match;
    while ((match = suffixPattern.exec(text)) !== null) {
      if (match[1]) {
        addCandidate(match[1], 0.8 * multiplier, source);
      }
    }

    // Pattern 2: German address prefix patterns (e.g., "Am Stadtpark", "In der Altstadt")
    for (const prefix of STREET_PREFIXES) {
      const prefixPattern = new RegExp(
        `(?:^|[\\s,;(])(${prefix}\\s+[A-ZÄÖÜ][a-zäöüß]+(?:[\\s-][A-ZÄÖÜ]?[a-zäöüß]+)*)(?:\\s+\\d+[a-zA-Z]?)?(?=[\\s,;).]|$)`,
        'gm'
      );
      while ((match = prefixPattern.exec(text)) !== null) {
        if (match[1]) {
          addCandidate(match[1], 0.7 * multiplier, source);
        }
      }
    }

    // Pattern 3: Quoted street names (German guillemets or regular quotes)
    const quotedPattern = /[„"«"]((?:[A-ZÄÖÜ][a-zäöüß]+[\s-]*)+(?:straße|strasse|str\.|weg|allee|platz|ring|gasse|damm|ufer))["»"]/g;
    while ((match = quotedPattern.exec(text)) !== null) {
      if (match[1]) {
        addCandidate(match[1], 0.9 * multiplier, source);
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
