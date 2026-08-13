/**
 * Current-year ingestion orchestrator.
 *
 * Nightly job that ingests movies/series from the current year only.
 * Keeps MMDB fresh without waiting for the backlog pipeline to reach the current year.
 * Shares the concurrency lock with the main orchestrator — only one can run at a time.
 */

import { logger } from 'firebase-functions/v2';
import { GitHubClient } from './github-client.js';
import {
  buildMovieQuery,
  buildSeriesQuery,
  buildPersonQueryFromMovies,
  queryWikidata,
  parseMovieResults,
  parseSeriesResults,
  parsePersonResults,
} from './wikidata-client.js';
import { normalizeMovie, normalizeSeries, normalizePerson, MMDBMovie, MMDBSeries, MMDBPerson } from './normalizer.js';
import { getState, updateState, incrementIngested, acquireLock, releaseLock } from './state.js';
import { createYearRepo } from './repo-creator.js';
import { shouldAutoPause, isResultCountSane } from './safeguards.js';
import {
  PEOPLE_REPO,
  BRANCH_PREFIX,
  MAX_PEOPLE_PER_QUERY,
  MAX_EMPTY_RUNS,
  MAX_REPOS_PER_RUN,
  CURRENT_YEAR_MOVIES_LIMIT,
  CURRENT_YEAR_SERIES_LIMIT,
} from '../config.js';
import { IngestionResult } from './orchestrator.js';

/**
 * Pure function: determines whether current-year state should be reset.
 * Exported for unit testing.
 */
export function shouldResetCurrentYearState(stateYear: number, actualYear: number): boolean {
  return stateYear !== actualYear;
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
      logger.info('Year rollover detected, resetting current-year offsets', {
        previousYear: state.current_year,
        newYear: currentYear,
      });
      await updateState({
        current_year: currentYear,
        current_year_offset_movies: 0,
        current_year_offset_series: 0,
      });
    }

    // Re-fetch state after potential update
    const freshState = await getState();
    const movieOffset = freshState.current_year_offset_movies;
    const seriesOffset = freshState.current_year_offset_series;

    // Reset per-run repo creation counter
    await updateState({ repos_created_this_run: 0 });

    logger.info('Starting current-year ingestion', {
      year: currentYear,
      movieOffset,
      seriesOffset,
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

    // ─── Query Wikidata for movies ───────────────────────────────────────────
    const movieWikidataIds: string[] = [];
    const movies: MMDBMovie[] = [];

    try {
      const movieQuery = buildMovieQuery(currentYear, CURRENT_YEAR_MOVIES_LIMIT, movieOffset);
      const movieResults = await queryWikidata(movieQuery);
      const parsedMovies = parseMovieResults(movieResults);

      if (!isResultCountSane(parsedMovies.length)) {
        logger.error('Current-year movie query returned too many results — skipping', {
          year: currentYear,
          count: parsedMovies.length,
        });
        result.errors.push(`Sanity check failed: current-year movie query returned ${parsedMovies.length} results`);
      } else {
        // Deduplication
        const existingMovieIds = await github.getExistingMovieIds(yearRepo);
        const pendingMovieIds = await github.getMoviesInPendingPRs(yearRepo);
        const allExistingMovieIds = new Set([...existingMovieIds, ...pendingMovieIds]);

        for (const wikiMovie of parsedMovies) {
          try {
            const movie = normalizeMovie(wikiMovie);
            if (allExistingMovieIds.has(movie.id)) {
              logger.debug('Skipping duplicate movie', { id: movie.id });
              continue;
            }
            movies.push(movie);
            movieWikidataIds.push(wikiMovie.wikidataId);
          } catch (error: any) {
            result.errors.push(`Movie normalize error: ${wikiMovie.label} — ${error.message}`);
            logger.error('Movie normalization failed', { movie: wikiMovie.label, error: error.message });
          }
        }
      }
    } catch (error: any) {
      result.errors.push(`Current-year movie query error: ${error.message}`);
      logger.error('Current-year movie query failed', { year: currentYear, error: error.message });
    }

    // ─── Query Wikidata for series ───────────────────────────────────────────
    const series: MMDBSeries[] = [];

    try {
      const seriesQuery = buildSeriesQuery(currentYear, CURRENT_YEAR_SERIES_LIMIT, seriesOffset);
      const seriesResults = await queryWikidata(seriesQuery);
      const parsedSeries = parseSeriesResults(seriesResults);

      if (!isResultCountSane(parsedSeries.length)) {
        logger.error('Current-year series query returned too many results — skipping', {
          year: currentYear,
          count: parsedSeries.length,
        });
        result.errors.push(`Sanity check failed: current-year series query returned ${parsedSeries.length} results`);
      } else {
        // Deduplication
        const existingSeriesIds = await github.getExistingSeriesIds(yearRepo);
        const pendingSeriesIds = await github.getSeriesInPendingPRs(yearRepo);
        const allExistingSeriesIds = new Set([...existingSeriesIds, ...pendingSeriesIds]);

        for (const wikiSeries of parsedSeries) {
          try {
            const seriesItem = normalizeSeries(wikiSeries);
            if (allExistingSeriesIds.has(seriesItem.id)) {
              logger.debug('Skipping duplicate series', { id: seriesItem.id });
              continue;
            }
            series.push(seriesItem);
          } catch (error: any) {
            result.errors.push(`Series normalize error: ${wikiSeries.label} — ${error.message}`);
            logger.error('Series normalization failed', { series: wikiSeries.label, error: error.message });
          }
        }
      }
    } catch (error: any) {
      result.errors.push(`Current-year series query error: ${error.message}`);
      logger.error('Current-year series query failed', { year: currentYear, error: error.message });
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

        for (const movie of movies) {
          try {
            await github.addMovieToPR(yearRepo, branchName, movie);
            result.moviesIngested++;
          } catch (error: any) {
            result.errors.push(`Failed to add movie ${movie.title}: ${error.message}`);
            logger.error('Failed to add movie to PR', { movie: movie.title, error: error.message });
          }
        }

        for (const seriesItem of series) {
          try {
            await github.addSeriesToPR(yearRepo, branchName, seriesItem);
            result.seriesIngested++;
          } catch (error: any) {
            result.errors.push(`Failed to add series ${seriesItem.title}: ${error.message}`);
            logger.error('Failed to add series to PR', { series: seriesItem.title, error: error.message });
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
            (movies.length > 0 ? `**Movies (${result.moviesIngested}):**\n${movies.slice(0, 20).map(m => `- ${m.title}`).join('\n')}\n\n` : '') +
            (series.length > 0 ? `**Series (${result.seriesIngested}):**\n${series.slice(0, 20).map(s => `- ${s.title}`).join('\n')}\n` : '')
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

          for (const person of newPeople) {
            try {
              await github.addPersonToPR(PEOPLE_REPO, peopleBranch, person);
              result.peopleIngested++;
            } catch (error: any) {
              result.errors.push(`Failed to add person ${person.name}: ${error.message}`);
              logger.error('Failed to add person to PR', { person: person.name, error: error.message });
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
      // Advance offsets
      await updateState({
        current_year_offset_movies: movieOffset + CURRENT_YEAR_MOVIES_LIMIT,
        current_year_offset_series: seriesOffset + CURRENT_YEAR_SERIES_LIMIT,
      });

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
