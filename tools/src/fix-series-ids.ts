#!/usr/bin/env node
/**
 * Fix Series Duplicate IDs (TASK-147)
 *
 * Renames series IDs from `s_{slug}` to `s_{slug}_{start_year}`.
 * Handles collisions by appending Wikidata QID number.
 * Removes true duplicates (same QID in wrong repo).
 *
 * Usage:
 *   npx tsx tools/src/fix-series-ids.ts --dry-run                # preview all repos
 *   npx tsx tools/src/fix-series-ids.ts --year=2026 --dry-run    # preview single repo
 *   npx tsx tools/src/fix-series-ids.ts --all                    # apply to all repos
 *   npx tsx tools/src/fix-series-ids.ts --all --commit           # apply + git commit
 */

import { readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeriesEntry {
  filePath: string;
  repoYear: number;
  repoPath: string;
  id: string;
  startYear: number;
  wikidata: string;
  title: string;
  data: Record<string, unknown>;
}

interface RenameAction {
  type: 'rename';
  entry: SeriesEntry;
  newId: string;
  newFilePath: string;
}

interface DeleteAction {
  type: 'delete';
  entry: SeriesEntry;
  reason: string;
}

type Action = RenameAction | DeleteAction;

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const yearFlag = args.find(a => a.startsWith('--year='));
const allFlag = args.includes('--all');
const dryRun = args.includes('--dry-run');
const commitFlag = args.includes('--commit');

if (!yearFlag && !allFlag && !dryRun) {
  console.error('Usage: npx tsx tools/src/fix-series-ids.ts [--year=YYYY | --all] [--dry-run] [--commit]');
  console.error('  --year=YYYY   Process single year repo');
  console.error('  --all         Process all year repos (2000-2026)');
  console.error('  --dry-run     Preview changes without applying');
  console.error('  --commit      Git commit after applying changes');
  process.exit(1);
}

const REPOS_DIR = join(process.env.HOME || '/home/jmrmedev', 'repos');
const START_YEAR = 2000;
const END_YEAR = 2026;

function getYearsToProcess(): number[] {
  if (yearFlag) {
    const y = parseInt(yearFlag.split('=')[1]);
    if (isNaN(y) || y < START_YEAR || y > END_YEAR) {
      console.error(`Invalid year: ${yearFlag.split('=')[1]}`);
      process.exit(1);
    }
    return [y];
  }
  const years: number[] = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) years.push(y);
  return years;
}

// ─── Scan ────────────────────────────────────────────────────────────────────

function scanRepo(year: number): SeriesEntry[] {
  const repoPath = join(REPOS_DIR, `mmdb-${year}`);
  const seriesDir = join(repoPath, 'data', 'series');

  if (!existsSync(seriesDir)) return [];

  const files = readdirSync(seriesDir).filter(f => f.endsWith('.json') && f !== 'index.json');
  const entries: SeriesEntry[] = [];

  for (const file of files) {
    const filePath = join(seriesDir, file);
    try {
      const content = readFileSync(filePath, 'utf8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const id = data.id as string;
      const startYear = data.start_year as number;
      const externalIds = data.external_ids as Record<string, unknown> | undefined;
      const wikidata = externalIds?.wikidata as string || '';
      const title = (data.title as string) || '';

      if (!id || !startYear) {
        console.warn(`  ⚠ Skipping ${file} in mmdb-${year}: missing id or start_year`);
        continue;
      }

      entries.push({
        filePath,
        repoYear: year,
        repoPath,
        id,
        startYear,
        wikidata,
        title,
        data,
      });
    } catch (err) {
      console.warn(`  ⚠ Error reading ${file} in mmdb-${year}: ${(err as Error).message}`);
    }
  }

  return entries;
}

// ─── Compute new IDs ─────────────────────────────────────────────────────────

function extractSlug(currentId: string): string {
  // Remove `s_` prefix
  let slug = currentId.replace(/^s_/, '');
  // Remove any trailing _YYYY (4 digits at end after underscore) — in case some already have year
  slug = slug.replace(/_\d{4}$/, '');
  return slug;
}

function computeNewId(slug: string, startYear: number): string {
  return `s_${slug}_${startYear}`;
}

function extractQidNumber(wikidata: string): string {
  // Q12345 → 12345
  return wikidata.replace(/^Q/, '');
}

// ─── Plan actions ────────────────────────────────────────────────────────────

function planActions(allEntries: SeriesEntry[]): Action[] {
  // Group by Wikidata QID to find true duplicates
  const byQid = new Map<string, SeriesEntry[]>();
  for (const entry of allEntries) {
    if (!entry.wikidata) continue;
    const existing = byQid.get(entry.wikidata) || [];
    existing.push(entry);
    byQid.set(entry.wikidata, existing);
  }

  // Identify true duplicates: same QID in multiple repos → keep the one with earliest start_year
  // (which is the true premiere date). If tied, prefer the repo matching start_year.
  const toDelete = new Set<string>(); // filePath set
  let duplicateCount = 0;

  for (const [qid, entries] of byQid) {
    if (entries.length <= 1) continue;

    // Sort by start_year ascending, then prefer repo matching start_year
    const sorted = [...entries].sort((a, b) => {
      if (a.startYear !== b.startYear) return a.startYear - b.startYear;
      // Prefer the one where repoYear matches startYear
      const aMatch = a.repoYear === a.startYear ? 0 : 1;
      const bMatch = b.repoYear === b.startYear ? 0 : 1;
      return aMatch - bMatch;
    });

    const correctEntry = sorted[0];
    for (const entry of entries) {
      if (entry !== correctEntry) {
        toDelete.add(entry.filePath);
        duplicateCount++;
      }
    }
  }

  if (duplicateCount > 0) {
    console.log(`  Found ${duplicateCount} true duplicates (same QID in wrong repo) — will delete`);
  }

  // Now compute new IDs for entries that survive
  const surviving = allEntries.filter(e => !toDelete.has(e.filePath));

  // Proposed IDs → track collisions
  const proposedIds = new Map<string, SeriesEntry[]>(); // newId → entries

  for (const entry of surviving) {
    const slug = extractSlug(entry.id);
    const newId = computeNewId(slug, entry.startYear);
    const existing = proposedIds.get(newId) || [];
    existing.push(entry);
    proposedIds.set(newId, existing);
  }

  // Resolve collisions
  const actions: Action[] = [];

  // Add delete actions — also note which entry is being kept
  const keptByQid = new Map<string, SeriesEntry>();
  for (const entry of surviving) {
    if (entry.wikidata) keptByQid.set(entry.wikidata, entry);
  }

  for (const entry of allEntries) {
    if (toDelete.has(entry.filePath)) {
      const kept = keptByQid.get(entry.wikidata);
      const keepRepo = kept ? `mmdb-${kept.repoYear}` : 'unknown';
      actions.push({
        type: 'delete',
        entry,
        reason: `Duplicate QID ${entry.wikidata} — keeping in ${keepRepo} (start_year=${kept?.startYear})`,
      });
    }
  }

  // Add rename actions
  for (const [newId, entries] of proposedIds) {
    if (entries.length === 1) {
      // No collision — straightforward rename
      const entry = entries[0];
      const slug = newId.replace(/^s_/, '');
      const newFileName = `${slug.replace(/_(\d{4})$/, '-$1')}.json`;
      const newFilePath = join(entry.repoPath, 'data', 'series', newFileName);

      actions.push({
        type: 'rename',
        entry,
        newId,
        newFilePath,
      });
    } else {
      // Collision — same slug + same year, different QIDs → append QID number
      console.log(`  Collision: ${newId} (${entries.length} entries) — resolving with QID suffix`);
      for (const entry of entries) {
        const qidNum = extractQidNumber(entry.wikidata);
        const resolvedId = `${newId}_${qidNum}`;
        const slug = resolvedId.replace(/^s_/, '');
        const newFileName = `${slug.replace(/_(\d{4})_/, '-$1_')}.json`;
        const newFilePath = join(entry.repoPath, 'data', 'series', newFileName);

        actions.push({
          type: 'rename',
          entry,
          newId: resolvedId,
          newFilePath,
        });
      }
    }
  }

  return actions;
}

// ─── Apply actions ───────────────────────────────────────────────────────────

function applyActions(actions: Action[]): { renamed: number; deleted: number; errors: string[] } {
  let renamed = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const action of actions) {
    try {
      if (action.type === 'delete') {
        unlinkSync(action.entry.filePath);
        deleted++;
      } else if (action.type === 'rename') {
        // Update ID in JSON data
        const updatedData = { ...action.entry.data, id: action.newId };
        const content = JSON.stringify(updatedData, null, 2) + '\n';

        if (action.newFilePath === action.entry.filePath) {
          // Same file, just update content
          writeFileSync(action.entry.filePath, content);
        } else {
          // Write new file, delete old
          writeFileSync(action.newFilePath, content);
          if (existsSync(action.entry.filePath) && action.entry.filePath !== action.newFilePath) {
            unlinkSync(action.entry.filePath);
          }
        }
        renamed++;
      }
    } catch (err) {
      errors.push(`${action.type} ${action.type === 'delete' ? action.entry.filePath : (action as RenameAction).newFilePath}: ${(err as Error).message}`);
    }
  }

  return { renamed, deleted, errors };
}

// ─── Git commit ──────────────────────────────────────────────────────────────

async function gitCommit(years: number[]): Promise<void> {
  const { execSync } = await import('child_process');

  for (const year of years) {
    const repoPath = join(REPOS_DIR, `mmdb-${year}`);
    const seriesDir = join(repoPath, 'data', 'series');
    if (!existsSync(seriesDir)) continue;

    try {
      // Check if there are changes
      const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' });
      if (!status.trim()) continue;

      // Create branch
      try {
        execSync('git checkout -b fix/series-id-year', { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        // Branch might already exist
        execSync('git checkout fix/series-id-year', { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' });
      }

      // Stage all series changes
      execSync('git add data/series/', { cwd: repoPath, encoding: 'utf8' });

      // Commit with bot identity
      const env = {
        ...process.env,
        GIT_COMMITTER_NAME: 'mmdb-bot[bot]',
        GIT_COMMITTER_EMAIL: 'mmdb-bot[bot]@users.noreply.github.com',
      };
      execSync(
        'git commit --author="mmdb-bot[bot] <mmdb-bot[bot]@users.noreply.github.com>" -m "fix: rename series IDs to include start year"',
        { cwd: repoPath, encoding: 'utf8', env },
      );

      console.log(`  ✓ Committed in mmdb-${year}`);
    } catch (err) {
      console.error(`  ✗ Git error in mmdb-${year}: ${(err as Error).message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const years = getYearsToProcess();
  const mode = dryRun ? 'DRY RUN' : 'LIVE';

  console.log('═══════════════════════════════════════════════════════');
  console.log(`MMDB Fix Series IDs — ${mode}`);
  console.log(`Years: ${years.length === 1 ? years[0] : `${years[0]}–${years[years.length - 1]}`}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // Phase 1: Scan ALL year repos (even if processing a single year)
  // We need all entries to detect cross-repo duplicates
  console.log('Phase 1: Scanning all year repos...');
  const allEntries: SeriesEntry[] = [];
  const allYears: number[] = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) allYears.push(y);

  for (const year of allYears) {
    const entries = scanRepo(year);
    allEntries.push(...entries);
    if (entries.length > 0) {
      process.stdout.write(`  mmdb-${year}: ${entries.length} series\r`);
    }
  }
  console.log(`\n  Total: ${allEntries.length} series across ${allYears.length} repos\n`);

  // Phase 2: Plan actions (globally, to detect cross-repo duplicates)
  console.log('Phase 2: Computing new IDs and detecting collisions...');
  const actions = planActions(allEntries);

  // Filter actions to only the years we're processing
  const yearsSet = new Set(years);
  const filteredActions = actions.filter(a => {
    const entry = a.type === 'delete' ? a.entry : a.entry;
    return yearsSet.has(entry.repoYear);
  });

  const renameActions = filteredActions.filter(a => a.type === 'rename') as RenameAction[];
  const deleteActions = filteredActions.filter(a => a.type === 'delete') as DeleteAction[];

  // Count collisions (QID-suffixed IDs)
  const collisionCount = renameActions.filter(a => {
    // A collision-resolved ID has more than the standard pattern
    const parts = a.newId.replace(/^s_/, '').split('_');
    const lastPart = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    // Standard: s_slug_YYYY — collision: s_slug_YYYY_QIDNUM
    return /^\d{4}$/.test(secondLast) && /^\d+$/.test(lastPart) && lastPart.length > 4;
  }).length;

  console.log(`\n  Actions for ${years.length === 1 ? `mmdb-${years[0]}` : 'all repos'}:`);
  console.log(`    Renames: ${renameActions.length}`);
  console.log(`    Deletes: ${deleteActions.length}`);
  console.log(`    Collisions (QID suffix): ${collisionCount}`);
  console.log('');

  // Phase 3: Preview or apply
  if (dryRun) {
    console.log('Phase 3: Preview (dry run)...');
    console.log('');

    if (deleteActions.length > 0) {
      console.log('  DELETIONS:');
      for (const action of deleteActions.slice(0, 20)) {
        console.log(`    ✗ ${basename(action.entry.filePath)} in mmdb-${action.entry.repoYear} — ${action.reason}`);
      }
      if (deleteActions.length > 20) {
        console.log(`    ... and ${deleteActions.length - 20} more`);
      }
      console.log('');
    }

    console.log('  RENAMES (sample):');
    for (const action of renameActions.slice(0, 20)) {
      const oldFile = basename(action.entry.filePath);
      const newFile = basename(action.newFilePath);
      const idChange = action.entry.id !== action.newId ? ` (${action.entry.id} → ${action.newId})` : '';
      console.log(`    ${oldFile} → ${newFile}${idChange}`);
    }
    if (renameActions.length > 20) {
      console.log(`    ... and ${renameActions.length - 20} more`);
    }
  } else {
    console.log('Phase 3: Applying changes...');
    const result = applyActions(filteredActions);

    console.log(`\n  ✓ Renamed: ${result.renamed}`);
    console.log(`  ✓ Deleted: ${result.deleted}`);
    if (result.errors.length > 0) {
      console.log(`  ✗ Errors: ${result.errors.length}`);
      for (const err of result.errors.slice(0, 10)) {
        console.log(`    ${err}`);
      }
    }

    // Phase 4: Git commit if requested
    if (commitFlag) {
      console.log('\nPhase 4: Creating git commits...');
      await gitCommit(years);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
