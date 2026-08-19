/**
 * Current-year ingestion orchestrator.
 *
 * Nightly job that ingests movies/series from the current year only.
 * Uses full dedup scan (no offset pagination) to avoid permanently skipping titles.
 * Includes Pass B: recently-modified catch-up for films without P577 (publication date).
 * Shares the concurrency lock with the main orchestrator — only one can run at a time.
 */

import { logger } from 'firebase-functions/v2';
import { GitHubClient, groupByFirstLetter } from './github-client.js';
import { getMovieFilePath, getSeriesFilePath, getPersonFilePath, serializeEntity } from './github-helpers.js';
import {
  buildMovieQuery,
  buildSeriesQuery,
  buildRecentlyModifiedMovieQuery,
  buildRecentlyModifiedSeriesQuery,
  buildPersonQueryFromMovies,
  queryWikidata,
  parseMovieResults,
  parseSeriesResults,
  parsePersonResults,
} from './wikidata-client.js';
import { normalizeMovie, normalizeSeries, normalizePerson, MMDBMovie, MMDBSeries, MMDBPerson, isUsableTitle } from './normalizer.js';
import { getState, updateState, incrementIngested, acquireLock, releaseLock } from './state.js';
import { createYearRepo } from './repo-creator.js';
import { shouldAutoPause, isResultCountSane } from './safeguards.js';
import {
  PEOPLE_REPO,
  BRANCH_PREFIX,
  MAX_PEOPLE_PER_QUERY,
  MAX_EMPTY_RUNS,
  MAX_REPOS_PER_RUN,
  CURRENT_YEAR_FULL_SCAN_LIMIT,
  CURRENT_YEAR_SERIES_LIMIT,
  RECENT_MODIFIED_HOURS,
  RECENT_MODIFIED_LIMIT,
} from '../config.js';
import { IngestionResult } from './orchestrator.js';

/**
 * Pure function: determines whether current-year state should be reset.
 * Exported for unit testing.
 */
export function shouldResetCurrentYearState(stateYear: number, actualYear: number): boolean {
  return stateYear !== actualYear;
}

/**
 * Pure function: compute the ISO timestamp for N hours ago.
 * Exported for unit testing.
 */
export function computeModifiedAfter(hoursAgo: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
  return cutoff.toISOString();
}

export async function runCurrentYearIngestion(dryRun: boolean = false): Promise<IngestionResult> {
  const result: IngestionResult = {
    moviesIngested: 0,
    seriesIngested: 0,
    peopleIngested: 0,
    prsCreated: [],
    errors: [],
  };

  // ─── Anomaly Detection: check consecutive empty runs ───────────────────────
  const state = await getState();
  if (shouldAutoPause(state.consecutive_empty_runs)) {
    logger.error('Ingestion auto-paused: too many consecutive empty runs', {
      consecutive_empty_runs: state.consecutive_empty_runs,
      threshold: MAX_EMPTY_RUNS,
    });
    result.autoPaused = true;
    return result;
  }

  // ─── Concurrency Lock (shared with backlog) ────────────────────────────────
  const lockResult = await acquireLock();
  if (!lockResult.acquired) {
    logger.warn('Current-year ingestion skipped: lock not acquired', { reason: lockResult.reason });
    result.lockBlocked = true;
    result.errors.push(`Lock not acquired: ${lockResult.reason}`);
    return result;
  }

  try {
    const github = new GitHubClient();
    const currentYear = new Date().getFullYear();
    const yearRepo = `mmdb-${currentYear}`;
    const runDate = new Date().toISOString().split('T')[0];
    const branchSuffix = `cy-${runDate.replace(/-/g, '')}`;

    // ─── Year Rollover Detection ─────────────────────────────────────────────
    if (shouldResetCurrentYearState(state.current_year, currentYear)) {
      logger.info('Year rollover detected, resetting current-year state', {
        previousYear: state.current_year,
        newYear: currentYear,
      });
      await updateState({
        current_year: currentYear,
        current_year_offset_movies: 0,
        current_year_offset_series: 0,
      });
    }

    // Reset per-run repo creation counter
    await updateState({ repos_created_this_run: 0 });

    logger.info('Starting current-year ingestion (full dedup scan)', {
      year: currentYear,
      fullScanLimit: CURRENT_YEAR_FULL_SCAN_LIMIT,
      recentModifiedHours: RECENT_MODIFIED_HOURS,
      dryRun,
    });

    // ─── Ensure year repo exists ─────────────────────────────────────────────
    const repoAvailable = await github.repoExists(yearRepo);

    if (!repoAvailable) {
      const currentState = await getState();
      if ((currentState.repos_created_this_run || 0) >= MAX_REPOS_PER_RUN) {
        logger.info(`Repo ${yearRepo} missing but creation cap reached, skipping`);
        result.errors.push(`Repo ${yearRepo} does not exist and creation cap reached`);
        return result;
      }

      const creationResult = await createYearRepo(currentYear, dryRun);
      if (!creationResult.created) {
        logger.warn(`Could not create ${yearRepo}: ${creationResult.reason}`);
        result.errors.push(`Could not create ${yearRepo}: ${creationResult.reason}`);
        return result;
      }

      await updateState({
        repos_created_this_run: (currentState.repos_created_this_run || 0) + 1,
        last_repo_created: yearRepo,
        last_repo_created_at: new Date().toISOString(),
      });

      logger.info(`Created new repo: ${yearRepo}`);
    }

    // ─── Get existing IDs for deduplication (shared across passes) ───────────
    const existingMovieIds = await github.getExistingMovieIds(yearRepo);
    const pendingMovieIds = await github.getMoviesInPendingPRs(yearRepo);
    const allExistingMovieIds = new Set([...existingMovieIds, ...pendingMovieIds]);

    const existingSeriesIds = await github.getExistingSeriesIds(yearRepo);
    const pendingSeriesIds = await github.getSeriesInPendingPRs(yearRepo);
    const allExistingSeriesIds = new Set([...existingSeriesIds, ...pendingSeriesIds]);

    const movieWikidataIds: string[] = [];
    const movies: MMDBMovie[] = [];
    const series: MMDBSeries[] = [];
    // Track IDs added in this run to avoid duplicates between Pass A and Pass B
    const addedMovieIds = new Set<string>();
    const addedSeriesIds = new Set<string>();

    // ─── Pass A: Full dedup scan (movies with P577 in current year) ──────────
    try {
      // Query all movies for current year with no offset — dedup handles duplicates
      const movieQuery = buildMovieQuery(currentYear, CURRENT_YEAR_FULL_SCAN_LIMIT, 0);
      const movieResults = await queryWikidata(movieQuery);
      const parsedMovies = parseMovieResults(movieResults);

      if (!isResultCountSane(parsedMovies.length)) {
        logger.error('Current-year movie query returned too many results — skipping', {
          year: currentYear,
          count: parsedMovies.length,
        });
        result.errors.push(`Sanity check failed: current-year movie query returned ${parsedMovies.length} results`);
      } else {
        logger.info('Pass A: movies fetched', { count: parsedMovies.length });

        for (const wikiMovie of parsedMovies) {
          try {
            // Skip items with unusable titles (Q-IDs, non-Latin only, etc.)
            if (!isUsableTitle(wikiMovie.label)) {
              logger.debug('Skipping item with unusable title', { wikidataId: wikiMovie.wikidataId, label: wikiMovie.label });
              continue;
            }

            const movie = normalizeMovie(wikiMovie);
            if (allExistingMovieIds.has(movie.id)) {
              continue;
            }
            movies.push(movie);
            movieWikidataIds.push(wikiMovie.wikidataId);
            addedMovieIds.add(movie.id);
          } catch (error: any) {
            result.errors.push(`Movie normalize error: ${wikiMovie.label} — ${error.message}`);
            logger.error('Movie normalization failed', { movie: wikiMovie.label, error: error.message });
          }
        }
      }
    } catch (error: any) {
      result.errors.push(`Pass A movie query error: ${error.message}`);
      logger.error('Pass A movie query failed', { year: currentYear, error: error.message });
    }

    // ─── Pass A: Full dedup scan (series with P580 in current year) ──────────
    try {
      const seriesQuery = buildSeriesQuery(currentYear, CURRENT_YEAR_SERIES_LIMIT, 0);
      const seriesResults = await queryWikidata(seriesQuery);
      const parsedSeries = parseSeriesResults(seriesResults);

      if (!isResultCountSane(parsedSeries.length)) {
        logger.error('Current-year series query returned too many results — skipping', {
          year: currentYear,
          count: parsedSeries.length,
        });
        result.errors.push(`Sanity check failed: current-year series query returned ${parsedSeries.length} results`);
      } else {
        logger.info('Pass A: series fetched', { count: parsedSeries.length });

        for (const wikiSeries of parsedSeries) {
          try {
            // Skip items with unusable titles (Q-IDs, non-Latin only, etc.)
            if (!isUsableTitle(wikiSeries.label)) {
              logger.debug('Skipping item with unusable title', { wikidataId: wikiSeries.wikidataId, label: wikiSeries.label });
              continue;
            }

            const seriesItem = normalizeSeries(wikiSeries);
            if (allExistingSeriesIds.has(seriesItem.id)) {
              continue;
            }
            series.push(seriesItem);
            addedSeriesIds.add(seriesItem.id);
          } catch (error: any) {
            result.errors.push(`Series normalize error: ${wikiSeries.label} — ${error.message}`);
            logger.error('Series normalization failed', { series: wikiSeries.label, error: error.message });
          }
        }
      }
    } catch (error: any) {
      result.errors.push(`Pass A series query error: ${error.message}`);
      logger.error('Pass A series query failed', { year: currentYear, error: error.message });
    }

    // ─── Pass B: Recently modified catch-up (films without P577) ─────────────
    const modifiedAfter = computeModifiedAfter(RECENT_MODIFIED_HOURS);

    try {
      const recentMovieQuery = buildRecentlyModifiedMovieQuery(modifiedAfter, currentYear, RECENT_MODIFIED_LIMIT);
      const recentResults = await queryWikidata(recentMovieQuery);
      const recentMovies = parseMovieResults(recentResults);

      logger.info('Pass B: recently modified movies fetched', { count: recentMovies.length });

      for (const wikiMovie of recentMovies) {
        try {
          // Skip items with unusable titles (Q-IDs, non-Latin only, etc.)
          if (!isUsableTitle(wikiMovie.label)) {
            logger.debug('Skipping item with unusable title', { wikidataId: wikiMovie.wikidataId, label: wikiMovie.label });
            continue;
          }

          // Films with year=0 (no P577) get assigned to current year
          if (wikiMovie.year === 0) {
            wikiMovie.year = currentYear;
          }

          const movie = normalizeMovie(wikiMovie);

          // Skip if already exists or already added in Pass A
          if (allExistingMovieIds.has(movie.id) || addedMovieIds.has(movie.id)) {
            continue;
          }

          movies.push(movie);
          movieWikidataIds.push(wikiMovie.wikidataId);
          addedMovieIds.add(movie.id);
        } catch (error: any) {
          result.errors.push(`Pass B movie normalize error: ${wikiMovie.label} — ${error.message}`);
          logger.error('Pass B movie normalization failed', { movie: wikiMovie.label, error: error.message });
        }
      }
    } catch (error: any) {
      result.errors.push(`Pass B movie query error: ${error.message}`);
      logger.error('Pass B movie query failed', { error: error.message });
    }

    // ─── Pass B: Recently modified series catch-up ───────────────────────────
    try {
      const recentSeriesQuery = buildRecentlyModifiedSeriesQuery(modifiedAfter, currentYear, Math.floor(RECENT_MODIFIED_LIMIT / 2));
      const recentSeriesResults = await queryWikidata(recentSeriesQuery);
      const recentSeries = parseSeriesResults(recentSeriesResults);

      logger.info('Pass B: recently modified series fetched', { count: recentSeries.length });

      for (const wikiSeries of recentSeries) {
        try {
          // Skip items with unusable titles (Q-IDs, non-Latin only, etc.)
          if (!isUsableTitle(wikiSeries.label)) {
            logger.debug('Skipping item with unusable title', { wikidataId: wikiSeries.wikidataId, label: wikiSeries.label });
            continue;
          }

          // Series with startYear=0 (no P580) get assigned to current year
          if (wikiSeries.startYear === 0) {
            wikiSeries.startYear = currentYear;
          }

          const seriesItem = normalizeSeries(wikiSeries);

          // Skip if already exists or already added in Pass A
          if (allExistingSeriesIds.has(seriesItem.id) || addedSeriesIds.has(seriesItem.id)) {
            continue;
          }

          series.push(seriesItem);
          addedSeriesIds.add(seriesItem.id);
        } catch (error: any) {
          result.errors.push(`Pass B series normalize error: ${wikiSeries.label} — ${error.message}`);
          logger.error('Pass B series normalization failed', { series: wikiSeries.label, error: error.message });
        }
      }
    } catch (error: any) {
      result.errors.push(`Pass B series query error: ${error.message}`);
      logger.error('Pass B series query failed', { error: error.message });
    }

    // ─── Create title PRs ────────────────────────────────────────────────────
    const totalTitles = movies.length + series.length;

    if (totalTitles > 0 && !dryRun) {
      const branchName = `${BRANCH_PREFIX}/${currentYear}-${branchSuffix}`;

      try {
        const branchAlreadyExists = await github.branchExists(yearRepo, branchName);
        if (!branchAlreadyExists) {
          await github.createBranch(yearRepo, branchName);
        }

        // Batch movies by first letter
        const movieGroups = groupByFirstLetter(movies);
        for (const [letter, group] of movieGroups) {
          try {
            const files = group.map(m => ({ path: getMovieFilePath(m), content: serializeEntity(m) }));
            await github.commitBatch(yearRepo, branchName, files, `ingest: add ${group.length} movies (${letter})`);
            result.moviesIngested += group.length;
          } catch (error: any) {
            result.errors.push(`Failed to add movie batch (${letter}): ${error.message}`);
            logger.error('Failed to add movie batch to PR', { letter, count: group.length, error: error.message });
          }
        }

        // Batch series by first letter
        const seriesGroups = groupByFirstLetter(series);
        for (const [letter, group] of seriesGroups) {
          try {
            const files = group.map(s => ({ path: getSeriesFilePath(s), content: serializeEntity(s) }));
            await github.commitBatch(yearRepo, branchName, files, `ingest: add ${group.length} series (${letter})`);
            result.seriesIngested += group.length;
          } catch (error: any) {
            result.errors.push(`Failed to add series batch (${letter}): ${error.message}`);
            logger.error('Failed to add series batch to PR', { letter, count: group.length, error: error.message });
          }
        }

        if (result.moviesIngested + result.seriesIngested > 0) {
          const titleParts: string[] = [];
          if (result.moviesIngested > 0) titleParts.push(`${result.moviesIngested} movies`);
          if (result.seriesIngested > 0) titleParts.push(`${result.seriesIngested} series`);

          const prNumber = await github.createPullRequest(
            yearRepo,
            `ingest: add ${titleParts.join(', ')} (${currentYear} nightly)`,
            branchName,
            'master',
            `Automated current-year nightly ingestion for ${currentYear}:\n\n` +
            (movies.length > 0 ? `**Movies (${result.moviesIngested}):**\n${movies.slice(0, 20).map(m => m.title).join('\n')}\n\n` : '') +
            (series.length > 0 ? `**Series (${result.seriesIngested}):**\n${series.slice(0, 20).map(s => s.title).join('\n')}\n` : '')
          );
          result.prsCreated.push(`${yearRepo}#${prNumber}`);
          logger.info('Current-year title PR created', { repo: yearRepo, pr: prNumber });

          // Enable auto-merge (squash)
          try {
            await github.enableAutoMerge(yearRepo, prNumber);
            logger.info('Auto-merge enabled', { repo: yearRepo, pr: prNumber });
          } catch (error: any) {
            logger.warn('Could not enable auto-merge', { repo: yearRepo, pr: prNumber, error: error.message });
          }
        }
      } catch (error: any) {
        result.errors.push(`PR creation error for ${yearRepo}: ${error.message}`);
        logger.error('PR creation failed', { repo: yearRepo, error: error.message });
      }
    } else if (totalTitles > 0 && dryRun) {
      logger.info('[DRY RUN] Would create current-year title PR', {
        movies: movies.length,
        series: series.length,
      });
      result.moviesIngested = movies.length;
      result.seriesIngested = series.length;
    }

    // ─── People pass ─────────────────────────────────────────────────────────
    if (movieWikidataIds.length > 0) {
      try {
        const personQuery = buildPersonQueryFromMovies(movieWikidataIds, MAX_PEOPLE_PER_QUERY);
        const personResults = await queryWikidata(personQuery);
        const people = parsePersonResults(personResults);

        const existingPeopleIds = await github.getExistingPeopleIds(PEOPLE_REPO);
        const pendingPeopleIds = await github.getPeopleInPendingPRs(PEOPLE_REPO);
        const allExistingPeopleIds = new Set([...existingPeopleIds, ...pendingPeopleIds]);

        const newPeople: MMDBPerson[] = [];

        for (const wikiPerson of people) {
          try {
            const person = normalizePerson(wikiPerson);
            if (!person) continue;
            if (allExistingPeopleIds.has(person.id)) continue;
            newPeople.push(person);
          } catch (error: any) {
            result.errors.push(`Person normalize error: ${wikiPerson.label} — ${error.message}`);
            logger.error('Person normalization failed', { person: wikiPerson.label, error: error.message });
          }
        }

        if (newPeople.length > 0 && !dryRun) {
          const peopleBranch = `${BRANCH_PREFIX}/people-${branchSuffix}`;
          const branchAlreadyExists = await github.branchExists(PEOPLE_REPO, peopleBranch);

          if (!branchAlreadyExists) {
            await github.createBranch(PEOPLE_REPO, peopleBranch);
          }

          // Batch people by first letter
          const peopleGroups = groupByFirstLetter(newPeople);
          for (const [letter, group] of peopleGroups) {
            try {
              const files = group.map(p => ({ path: getPersonFilePath(p), content: serializeEntity(p) }));
              await github.commitBatch(PEOPLE_REPO, peopleBranch, files, `ingest: add ${group.length} people (${letter})`);
              result.peopleIngested += group.length;
            } catch (error: any) {
              result.errors.push(`Failed to add people batch (${letter}): ${error.message}`);
              logger.error('Failed to add people batch to PR', { letter, count: group.length, error: error.message });
            }
          }

          if (result.peopleIngested > 0) {
            const prNumber = await github.createPullRequest(
              PEOPLE_REPO,
              `ingest: add ${result.peopleIngested} people (${currentYear} nightly)`,
              peopleBranch,
              'master',
              `Automated current-year nightly ingestion: ${result.peopleIngested} new people from Wikidata.\n\nAssociated with ${currentYear} movies ingested on ${runDate}.`
            );
            result.prsCreated.push(`${PEOPLE_REPO}#${prNumber}`);
            logger.info('People PR created', { repo: PEOPLE_REPO, pr: prNumber, count: result.peopleIngested });

            // Enable auto-merge (squash)
            try {
              await github.enableAutoMerge(PEOPLE_REPO, prNumber);
              logger.info('Auto-merge enabled', { repo: PEOPLE_REPO, pr: prNumber });
            } catch (error: any) {
              logger.warn('Could not enable auto-merge', { repo: PEOPLE_REPO, pr: prNumber, error: error.message });
            }
          }
        } else if (newPeople.length > 0 && dryRun) {
          logger.info('[DRY RUN] Would create people PR', {
            count: newPeople.length,
            sample: newPeople.slice(0, 5).map(p => p.name),
          });
          result.peopleIngested = newPeople.length;
        }
      } catch (error: any) {
        result.errors.push(`People pass error: ${error.message}`);
        logger.error('People pass failed', { error: error.message });
      }
    }

    // ─── Update state ────────────────────────────────────────────────────────
    if (!dryRun) {
      // NOTE: We no longer advance offset-based pagination. The offset fields
      // remain in state for backward compatibility but are not used.
      await incrementIngested(result.moviesIngested, result.seriesIngested, result.peopleIngested);

      // Track consecutive empty runs
      if (totalTitles === 0) {
        const currentState = await getState();
        const newCount = currentState.consecutive_empty_runs + 1;
        await updateState({ consecutive_empty_runs: newCount });
        logger.warn('Empty current-year run detected', { consecutive_empty_runs: newCount });
      } else {
        await updateState({ consecutive_empty_runs: 0 });
      }
    }

    logger.info('Current-year ingestion complete', {
      moviesIngested: result.moviesIngested,
      seriesIngested: result.seriesIngested,
      peopleIngested: result.peopleIngested,
      prsCreated: result.prsCreated,
      errors: result.errors.length,
    });

    return result;
  } finally {
    await releaseLock();
  }
}
