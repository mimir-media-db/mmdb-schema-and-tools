/**
 * ID and slug generation for MMDB entities.
 * Self-contained copy adapted from tools/src/ingestion/id-generator.ts
 */

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim()
    .replace(/\s+/g, '_');
}

export function generateMovieId(title: string, year: number): string {
  const slug = generateSlug(title);
  return `m_${slug}_${year}`;
}

export function generatePersonId(name: string): string {
  const slug = generateSlug(name);
  return `p_${slug}`;
}

export function generateSeriesId(title: string): string {
  const slug = generateSlug(title);
  return `s_${slug}`;
}
