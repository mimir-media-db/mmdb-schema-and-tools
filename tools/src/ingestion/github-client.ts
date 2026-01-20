import { Octokit } from '@octokit/rest';
import { MMDBMovie, MMDBPerson } from './normalizer.js';
import { generateSlug } from './id-generator.js';

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  
  constructor(token: string, owner: string = 'mimir-media-db') {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
  }
  
  async createBranch(repo: string, branchName: string, baseBranch: string = 'master'): Promise<void> {
    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo,
      ref: `heads/${baseBranch}`
    });
    
    await this.octokit.git.createRef({
      owner: this.owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha
    });
  }
  
  async getExistingMovieIds(repo: string, branch: string = 'master'): Promise<Set<string>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: 'data/movies/index.json',
        ref: branch
      });
      
      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const index = JSON.parse(content);
        return new Set(index.map((entry: any) => entry.id));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return new Set();
      }
      throw error;
    }
    
    return new Set();
  }
  
  async getMoviesInPendingPRs(repo: string): Promise<Set<string>> {
    const movieIds = new Set<string>();
    
    try {
      // Get all open PRs
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: 'open'
      });
      
      // For each PR, get the files and extract movie IDs
      for (const pr of prs) {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.owner,
          repo,
          pull_number: pr.number
        });
        
        // Extract movie IDs from filenames in data/movies/
        for (const file of files) {
          if (file.filename.startsWith('data/movies/') && file.filename.endsWith('.json') && file.filename !== 'data/movies/index.json') {
            // Get the file content to extract the ID
            try {
              const { data: content } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo,
                path: file.filename,
                ref: pr.head.ref
              });
              
              if ('content' in content) {
                const movieData = JSON.parse(Buffer.from(content.content, 'base64').toString('utf-8'));
                if (movieData.id) {
                  movieIds.add(movieData.id);
                }
              }
            } catch (error) {
              // Skip if file can't be read
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      console.warn('Warning: Could not fetch pending PRs:', error.message);
    }
    
    return movieIds;
  }
  
  async createOrUpdateFile(
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string
  ): Promise<void> {
    let sha: string | undefined;
    
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path,
        ref: branch
      });
      
      if ('sha' in data) {
        sha = data.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) throw error;
    }
    
    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha && { sha })
    });
  }
  
  async createPullRequest(
    repo: string,
    title: string,
    head: string,
    base: string = 'master',
    body?: string
  ): Promise<number> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo,
      title,
      head,
      base,
      body
    });
    
    return data.number;
  }
  
  async addMovieToPR(repo: string, branch: string, movie: MMDBMovie): Promise<void> {
    const slug = generateSlug(movie.title);
    const filename = `${slug}-${movie.year}.json`;
    const path = `data/movies/${filename}`;
    const content = JSON.stringify(movie, null, 2) + '\n';
    
    await this.createOrUpdateFile(
      repo,
      branch,
      path,
      content,
      `Add ${movie.title} (${movie.year})`
    );
  }
  
  async getExistingPeopleIds(repo: string = 'mmdb-people', branch: string = 'master'): Promise<Set<string>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: 'data/people/index.json',
        ref: branch
      });
      
      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const index = JSON.parse(content);
        return new Set(index.map((entry: any) => entry.id));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return new Set();
      }
      throw error;
    }
    
    return new Set();
  }
  
  async getPeopleInPendingPRs(repo: string = 'mmdb-people'): Promise<Set<string>> {
    const peopleIds = new Set<string>();
    
    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: 'open'
      });
      
      for (const pr of prs) {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.owner,
          repo,
          pull_number: pr.number
        });
        
        for (const file of files) {
          if (file.filename.startsWith('data/people/') && file.filename.endsWith('.json') && file.filename !== 'data/people/index.json') {
            try {
              const { data: content } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo,
                path: file.filename,
                ref: pr.head.ref
              });
              
              if ('content' in content) {
                const personData = JSON.parse(Buffer.from(content.content, 'base64').toString('utf-8'));
                if (personData.id) {
                  peopleIds.add(personData.id);
                }
              }
            } catch (error) {
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      console.warn('Warning: Could not fetch pending PRs:', error.message);
    }
    
    return peopleIds;
  }
  
  async addPersonToPR(repo: string, branch: string, person: MMDBPerson): Promise<void> {
    const filename = `${person.id}.json`;
    const path = `data/people/${filename}`;
    const content = JSON.stringify(person, null, 2) + '\n';
    
    await this.createOrUpdateFile(
      repo,
      branch,
      path,
      content,
      `Add ${person.name}`
    );
  }
}
