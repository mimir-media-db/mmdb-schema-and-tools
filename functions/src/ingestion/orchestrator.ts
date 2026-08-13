/**
 * Main orchestrator for the MMDB dual-pass ingestion pipeline.
 *
 * Pass 1 — Backlog: Iterates through years sequentially, ingesting movies/series.
 * Pass 2 — Recent: Fetches recently modified titles from Wikidata.
 * Pass 3 — People: Fetches people associated with newly ingested movies.
 */

import { logger } from 'firebase-functions/v2';
import {
  buildMovieQuery,
  buildRecentMovieQuery,
  buildSeriesQuery,
  buildRecentSeriesQuery,
  buildPersonQueryFromMovies,
  queryWikidata,
  parseMovieResults,
  parseSeriesResults,
  parsePersonResults,
} from './wikidata-client.js';
import { GitHubClient } from './github-client.js';
import { normalizeMovie, normalizePerson, normalizeSeries, MMDBMovie, MMDBSeries, MMDBPerson } from './normalizer.js';
import { getState, updateState, incrementIngested, advanceBacklog, acquireLock, releaseLock } from './state.js';
import {
  BACKLOG_LIMIT,
  RECENT_LIMIT,
  MAX_TITLES_PER_RUN,
  MAX_YEAR,
  PEOPLE_REPO,
  BRANCH_PREFIX,
  MAX_PEOPLE_PER_QUERY,
  MAX_EMPTY_RUNS,
  MAX_RESULTS_SANITY,
} from '../config.js';
import { shouldAutoPause, isResultCountSane } from './safeguards.js';

export interface IngestionResult {
  moviesIngested: number;
  seriesIngested: number;
  peopleIngested: number;
  prsCreated: string[];
  errors: string[];
  autoPaused?: boolean;
  lockBlocked?: boolean;
}

interface TitleBatch {
  movies: Map<number, MMDBMovie[]>; // year → movies
  series: Map<number, MMDBSeries[]>; // year → series
  movieWikidataIds: string[];
}

export async function runIngestion(githubToken: string, dryRun: boolean = false): Promise<IngestionResult> {
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

  // ─── Concurrency Lock ──────────────────────────────────────────────────────
  const lockResult = await acquireLock();
  if (!lockResult.acquired) {
    logger.warn('Ingestion skipped: lock not acquired', { reason: lockResult.reason });
    result.lockBlocked = true;
    result.errors.push(`Lock not acquired: ${lockResult.reason}`);
    return result;
  }

  try {
    const github = new GitHubClient(githubToken);
    const runDate = new Date().toISOString().split('T')[0];
    const branchSuffix = runDate.replace(/-/g, '');

    logger.info('Starting ingestion run', {
      state,
      dryRun,
      runDate,
    });

    // ─── Pass 1: Backlog ─────────────────────────────────────────────────────
    const backlogTitles = await runBacklogPass(github, state.backlog_current_year, state.backlog_offset, result);

    // ─── Pass 2: Recent ──────────────────────────────────────────────────────
    const recentTitles = await runRecentPass(github, state.last_recent_timestamp, result);

    // ─── Merge title batches ─────────────────────────────────────────────────
    const allTitles = mergeBatches(backlogTitles, recentTitles);

    // ─── Create PRs for movies and series ────────────────────────────────────
    if (!dryRun) {
      await createTitlePRs(github, allTitles, branchSuffix, result);
    } else {
      logDryRunTitles(allTitles, result);
    }

    // ─── Pass 3: People ──────────────────────────────────────────────────────
    const allWikidataIds = [
      ...backlogTitles.movieWikidataIds,
      ...recentTitles.movieWikidataIds,
    ];

    if (allWikidataIds.length > 0) {
      await runPeoplePass(github, allWikidataIds, branchSuffix, dryRun, result);
    }

    // ─── Update state ────────────────────────────────────────────────────────
    if (!dryRun) {
      await incrementIngested(result.moviesIngested, result.seriesIngested, result.peopleIngested);

      // ─── Anomaly Detection: track consecutive empty runs ───────────────────
      const totalTitles = result.moviesIngested + result.seriesIngested;
      if (totalTitles === 0) {
        const currentState = await getState();
        const newCount = currentState.consecutive_empty_runs + 1;
        await updateState({ consecutive_empty_runs: newCount });
        logger.warn('Empty run detected', { consecutive_empty_runs: newCount });

        if (newCount >= MAX_EMPTY_RUNS) {
          logger.error('Ingestion will be auto-paused on next run', {
            consecutive_empty_runs: newCount,
            threshold: MAX_EMPTY_RUNS,
          });
        }
      } else {
        // Reset counter on successful ingestion
        await updateState({ consecutive_empty_runs: 0 });
      }
    }

    logger.info('Ingestion run complete', {
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

async function runBacklogPass(
  github: GitHubClient,
  currentYear: number,
  offset: number,
  result: IngestionResult
): Promise<TitleBatch> {
  const batch: TitleBatch = {
    movies: new Map(),
    series: new Map(),
    movieWikidataIds: [],
  };

  if (currentYear > MAX_YEAR) {
    logger.info('Backlog complete — all years processed');
    return batch;
  }

  logger.info('Backlog pass', { year: currentYear, offset });

  let titlesIngested = 0;
  const moviesLimit = Math.floor(BACKLOG_LIMIT * 0.7); // 70% movies
  const seriesLimit = BACKLOG_LIMIT - moviesLimit;     // 30% series

  // Fetch movies for backlog year
  try {
    const movieQuery = buildMovieQuery(currentYear, moviesLimit, offset);
    const movieResults = await queryWikidata(movieQuery);
    const movies = parseMovieResults(movieResults);

    // ─── Sanity Check: movie result count ────────────────────────────────────
    if (!isResultCountSane(movies.length)) {
      logger.error('Backlog movie query returned too many results — skipping', {
        year: currentYear,
        count: movies.length,
        threshold: MAX_RESULTS_SANITY,
      });
      result.errors.push(`Sanity check failed: backlog movie query for year ${currentYear} returned ${movies.length} results (max: ${MAX_RESULTS_SANITY})`);
      return batch;
    }

    // Check which repo this year maps to
    const yearRepo = `mmdb-${currentYear}`;
    const repoAvailable = await github.repoExists(yearRepo);

    if (!repoAvailable) {
      logger.warn(`Repo ${yearRepo} does not exist, skipping titles for year ${currentYear}`);
      await advanceBacklog(0, true, currentYear);
      return batch;
    }

    // Get existing IDs for deduplication
    const existingMovieIds = await github.getExistingMovieIds(yearRepo);
    const pendingMovieIds = await github.getMoviesInPendingPRs(yearRepo);
    const allExistingMovieIds = new Set([...existingMovieIds, ...pendingMovieIds]);

    for (const wikiMovie of movies) {
      if (titlesIngested >= BACKLOG_LIMIT) break;

      try {
        const movie = normalizeMovie(wikiMovie);

        if (allExistingMovieIds.has(movie.id)) {
          logger.debug('Skipping duplicate movie', { id: movie.id });
          continue;
        }

        if (!batch.movies.has(currentYear)) {
          batch.movies.set(currentYear, []);
        }
        batch.movies.get(currentYear)!.push(movie);
        batch.movieWikidataIds.push(wikiMovie.wikidataId);
        titlesIngested++;
      } catch (error: any) {
        result.errors.push(`Movie normalize error: ${wikiMovie.label} — ${error.message}`);
        logger.error('Movie normalization failed', { movie: wikiMovie.label, error: error.message });
      }
    }

    // Determine if year is exhausted
    const yearExhausted = movies.length < moviesLimit;

    // Fetch series for backlog year
    try {
      const seriesQuery = buildSeriesQuery(currentYear, seriesLimit, Math.floor(offset * 0.3));
      const seriesResults = await queryWikidata(seriesQuery);
      const seriesList = parseSeriesResults(seriesResults);

      // ─── Sanity Check: series result count ─────────────────────────────────
      if (!isResultCountSane(seriesList.length)) {
        logger.error('Backlog series query returned too many results — skipping', {
          year: currentYear,
          count: seriesList.length,
          threshold: MAX_RESULTS_SANITY,
        });
        result.errors.push(`Sanity check failed: backlog series query for year ${currentYear} returned ${seriesList.length} results (max: ${MAX_RESULTS_SANITY})`);
      } else {
        const existingSeriesIds = await github.getExistingSeriesIds(yearRepo);
        const pendingSeriesIds = await github.getSeriesInPendingPRs(yearRepo);
        const allExistingSeriesIds = new Set([...existingSeriesIds, ...pendingSeriesIds]);

        for (const wikiSeries of seriesList) {
          if (titlesIngested >= BACKLOG_LIMIT) break;

          try {
            const series = normalizeSeries(wikiSeries);

            if (allExistingSeriesIds.has(series.id)) {
              logger.debug('Skipping duplicate series', { id: series.id });
              continue;
            }

            if (!batch.series.has(currentYear)) {
              batch.series.set(currentYear, []);
            }
            batch.series.get(currentYear)!.push(series);
            titlesIngested++;
          } catch (error: any) {
            result.errors.push(`Series normalize error: ${wikiSeries.label} — ${error.message}`);
            logger.error('Series normalization failed', { series: wikiSeries.label, error: error.message });
          }
        }
      }
    } catch (error: any) {
      result.errors.push(`Series query error for year ${currentYear}: ${error.message}`);
      logger.error('Series query failed', { year: currentYear, error: error.message });
    }

    // Update backlog state
    const newOffset = offset + moviesLimit;
    await advanceBacklog(newOffset, yearExhausted, currentYear);
  } catch (error: any) {
    result.errors.push(`Backlog movie query error for year ${currentYear}: ${error.message}`);
    logger.error('Backlog movie query failed', { year: currentYear, error: error.message });
  }

  return batch;
}

async function runRecentPass(
  github: GitHubClient,
  lastTimestamp: string,
  result: IngestionResult
): Promise<TitleBatch> {
  const batch: TitleBatch = {
    movies: new Map(),
    series: new Map(),
    movieWikidataIds: [],
  };

  const remainingCap = MAX_TITLES_PER_RUN - BACKLOG_LIMIT;
  if (remainingCap <= 0) return batch;

  logger.info('Recent pass', { since: lastTimestamp });

  const movieLimit = Math.floor(RECENT_LIMIT * 0.7);
  const seriesLimit = RECENT_LIMIT - movieLimit;
  let titlesIngested = 0;

  // Recent movies
  try {
    const recentMovieQuery = buildRecentMovieQuery(lastTimestamp, movieLimit);
    const recentResults = await queryWikidata(recentMovieQuery);
    const recentMovies = parseMovieResults(recentResults);

    // ─── Sanity Check: recent movie result count ─────────────────────────────
    if (!isResultCountSane(recentMovies.length)) {
      logger.error('Recent movie query returned too many results — skipping', {
        count: recentMovies.length,
        threshold: MAX_RESULTS_SANITY,
      });
      result.errors.push(`Sanity check failed: recent movie query returned ${recentMovies.length} results (max: ${MAX_RESULTS_SANITY})`);
    } else {
      for (const wikiMovie of recentMovies) {
        if (titlesIngested >= RECENT_LIMIT) break;
        if (wikiMovie.year < 1900 || wikiMovie.year > MAX_YEAR) continue;

        try {
          const yearRepo = `mmdb-${wikiMovie.year}`;
          const repoAvailable = await github.repoExists(yearRepo);

          if (!repoAvailable) {
            logger.warn(`Repo ${yearRepo} missing, skipping recent movie`, { title: wikiMovie.label });
            continue;
          }

          const movie = normalizeMovie(wikiMovie);

          // Dedup check
          const existingIds = await github.getExistingMovieIds(yearRepo);
          const pendingIds = await github.getMoviesInPendingPRs(yearRepo);
          if (existingIds.has(movie.id) || pendingIds.has(movie.id)) {
            continue;
          }

          if (!batch.movies.has(wikiMovie.year)) {
            batch.movies.set(wikiMovie.year, []);
          }
          batch.movies.get(wikiMovie.year)!.push(movie);
          batch.movieWikidataIds.push(wikiMovie.wikidataId);
          titlesIngested++;
        } catch (error: any) {
          result.errors.push(`Recent movie error: ${wikiMovie.label} — ${error.message}`);
          logger.error('Recent movie processing failed', { movie: wikiMovie.label, error: error.message });
        }
      }
    }
  } catch (error: any) {
    result.errors.push(`Recent movie query error: ${error.message}`);
    logger.error('Recent movie query failed', { error: error.message });
  }

  // Recent series
  try {
    const recentSeriesQuery = buildRecentSeriesQuery(lastTimestamp, seriesLimit);
    const recentSeriesResults = await queryWikidata(recentSeriesQuery);
    const recentSeries = parseSeriesResults(recentSeriesResults);

    // ─── Sanity Check: recent series result count ────────────────────────────
    if (!isResultCountSane(recentSeries.length)) {
      logger.error('Recent series query returned too many results — skipping', {
        count: recentSeries.length,
        threshold: MAX_RESULTS_SANITY,
      });
      result.errors.push(`Sanity check failed: recent series query returned ${recentSeries.length} results (max: ${MAX_RESULTS_SANITY})`);
    } else {
      for (const wikiSeries of recentSeries) {
        if (titlesIngested >= RECENT_LIMIT) break;
        if (wikiSeries.startYear < 1900 || wikiSeries.startYear > MAX_YEAR) continue;

        try {
          const yearRepo = `mmdb-${wikiSeries.startYear}`;
          const repoAvailable = await github.repoExists(yearRepo);

          if (!repoAvailable) {
            logger.warn(`Repo ${yearRepo} missing, skipping recent series`, { title: wikiSeries.label });
            continue;
          }

          const series = normalizeSeries(wikiSeries);

          const existingIds = await github.getExistingSeriesIds(yearRepo);
          const pendingIds = await github.getSeriesInPendingPRs(yearRepo);
          if (existingIds.has(series.id) || pendingIds.has(series.id)) {
            continue;
          }

          if (!batch.series.has(wikiSeries.startYear)) {
            batch.series.set(wikiSeries.startYear, []);
          }
          batch.series.get(wikiSeries.startYear)!.push(series);
          titlesIngested++;
        } catch (error: any) {
          result.errors.push(`Recent series error: ${wikiSeries.label} — ${error.message}`);
          logger.error('Recent series processing failed', { series: wikiSeries.label, error: error.message });
        }
      }
    }
  } catch (error: any) {
    result.errors.push(`Recent series query error: ${error.message}`);
    logger.error('Recent series query failed', { error: error.message });
  }

  // Update the recent timestamp
  await updateState({ last_recent_timestamp: new Date().toISOString() });

  return batch;
}

async function runPeoplePass(
  github: GitHubClient,
  movieWikidataIds: string[],
  branchSuffix: string,
  dryRun: boolean,
  result: IngestionResult
): Promise<void> {
  logger.info('People pass', { movieCount: movieWikidataIds.length });

  try {
    const personQuery = buildPersonQueryFromMovies(movieWikidataIds, MAX_PEOPLE_PER_QUERY);
    const personResults = await queryWikidata(personQuery);
    const people = parsePersonResults(personResults);

    // Dedup against existing people
    const existingPeopleIds = await github.getExistingPeopleIds(PEOPLE_REPO);
    const pendingPeopleIds = await github.getPeopleInPendingPRs(PEOPLE_REPO);
    const allExistingPeopleIds = new Set([...existingPeopleIds, ...pendingPeopleIds]);

    const newPeople: MMDBPerson[] = [];

    for (const wikiPerson of people) {
      try {
        const person = normalizePerson(wikiPerson);

        if (allExistingPeopleIds.has(person.id)) {
          continue;
        }

        newPeople.push(person);
      } catch (error: any) {
        result.errors.push(`Person normalize error: ${wikiPerson.label} — ${error.message}`);
        logger.error('Person normalization failed', { person: wikiPerson.label, error: error.message });
      }
    }

    if (newPeople.length === 0) {
      logger.info('No new people to ingest');
      return;
    }

    if (dryRun) {
      logger.info('[DRY RUN] Would create people PR', {
        count: newPeople.length,
        sample: newPeople.slice(0, 5).map(p => p.name),
      });
      result.peopleIngested = newPeople.length;
      return;
    }

    // Create branch and add people
    const branchName = `${BRANCH_PREFIX}/people-${branchSuffix}`;
    const branchAlreadyExists = await github.branchExists(PEOPLE_REPO, branchName);

    if (!branchAlreadyExists) {
      await github.createBranch(PEOPLE_REPO, branchName);
    }

    for (const person of newPeople) {
      try {
        await github.addPersonToPR(PEOPLE_REPO, branchName, person);
        result.peopleIngested++;
      } catch (error: any) {
        result.errors.push(`Failed to add person ${person.name}: ${error.message}`);
        logger.error('Failed to add person to PR', { person: person.name, error: error.message });
      }
    }

    if (result.peopleIngested > 0) {
      const prNumber = await github.createPullRequest(
        PEOPLE_REPO,
        `ingest: add ${result.peopleIngested} people (${branchSuffix})`,
        branchName,
        'master',
        `Automated ingestion: ${result.peopleIngested} new people from Wikidata.\n\nAssociated with movies ingested on ${branchSuffix}.`
      );
      result.prsCreated.push(`${PEOPLE_REPO}#${prNumber}`);
      logger.info('People PR created', { repo: PEOPLE_REPO, pr: prNumber, count: result.peopleIngested });
    }
  } catch (error: any) {
    result.errors.push(`People pass error: ${error.message}`);
    logger.error('People pass failed', { error: error.message });
  }
}

async function createTitlePRs(
  github: GitHubClient,
  allTitles: TitleBatch,
  branchSuffix: string,
  result: IngestionResult
): Promise<void> {
  // Group by year repo
  const allYears = new Set([
    ...allTitles.movies.keys(),
    ...allTitles.series.keys(),
  ]);

  for (const year of allYears) {
    const yearRepo = `mmdb-${year}`;
    const branchName = `${BRANCH_PREFIX}/${year}-${branchSuffix}`;

    const movies = allTitles.movies.get(year) || [];
    const series = allTitles.series.get(year) || [];
    const totalForYear = movies.length + series.length;

    if (totalForYear === 0) continue;

    try {
      const branchAlreadyExists = await github.branchExists(yearRepo, branchName);

      if (!branchAlreadyExists) {
        await github.createBranch(yearRepo, branchName);
      }

      // Add movies
      for (const movie of movies) {
        try {
          await github.addMovieToPR(yearRepo, branchName, movie);
          result.moviesIngested++;
        } catch (error: any) {
          result.errors.push(`Failed to add movie ${movie.title}: ${error.message}`);
          logger.error('Failed to add movie to PR', { movie: movie.title, error: error.message });
        }
      }

      // Add series
      for (const seriesItem of series) {
        try {
          await github.addSeriesToPR(yearRepo, branchName, seriesItem);
          result.seriesIngested++;
        } catch (error: any) {
          result.errors.push(`Failed to add series ${seriesItem.title}: ${error.message}`);
          logger.error('Failed to add series to PR', { series: seriesItem.title, error: error.message });
        }
      }

      // Create PR
      if (result.moviesIngested + result.seriesIngested > 0) {
        const titleParts: string[] = [];
        if (movies.length > 0) titleParts.push(`${movies.length} movies`);
        if (series.length > 0) titleParts.push(`${series.length} series`);

        const prNumber = await github.createPullRequest(
          yearRepo,
          `ingest: add ${titleParts.join(', ')} (${year})`,
          branchName,
          'master',
          `Automated ingestion for year ${year}:\n\n` +
          (movies.length > 0 ? `**Movies (${movies.length}):**\n${movies.map(m => `- ${m.title}`).join('\n')}\n\n` : '') +
          (series.length > 0 ? `**Series (${series.length}):**\n${series.map(s => `- ${s.title}`).join('\n')}\n` : '')
        );
        result.prsCreated.push(`${yearRepo}#${prNumber}`);
        logger.info('Title PR created', { repo: yearRepo, pr: prNumber, movies: movies.length, series: series.length });
      }
    } catch (error: any) {
      result.errors.push(`PR creation error for ${yearRepo}: ${error.message}`);
      logger.error('PR creation failed', { repo: yearRepo, error: error.message });
    }
  }
}

function mergeBatches(a: TitleBatch, b: TitleBatch): TitleBatch {
  const merged: TitleBatch = {
    movies: new Map(a.movies),
    series: new Map(a.series),
    movieWikidataIds: [...a.movieWikidataIds, ...b.movieWikidataIds],
  };

  for (const [year, movies] of b.movies) {
    const existing = merged.movies.get(year) || [];
    merged.movies.set(year, [...existing, ...movies]);
  }

  for (const [year, series] of b.series) {
    const existing = merged.series.get(year) || [];
    merged.series.set(year, [...existing, ...series]);
  }

  return merged;
}

function logDryRunTitles(batch: TitleBatch, result: IngestionResult): void {
  for (const [year, movies] of batch.movies) {
    logger.info(`[DRY RUN] Would ingest ${movies.length} movies for year ${year}`, {
      titles: movies.map(m => m.title),
    });
    result.moviesIngested += movies.length;
  }

  for (const [year, series] of batch.series) {
    logger.info(`[DRY RUN] Would ingest ${series.length} series for year ${year}`, {
      titles: series.map(s => s.title),
    });
    result.seriesIngested += series.length;
  }
}
