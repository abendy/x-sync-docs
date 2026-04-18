#!/usr/bin/env tsx
/**
 * T1.4 - Document current rate limits from response headers
 *
 * Makes one request to each relevant endpoint and logs the
 * rate limit headers to document the current limits.
 *
 * Endpoints tested:
 *   - GET /2/users/:id/bookmarks          (bookmark lookup)
 *   - GET /2/users/:id/bookmarks/folders   (folder list)
 *   - GET /2/tweets/:id                    (tweet lookup)
 *   - GET /2/users/me                      (user lookup)
 *
 * Usage: pnpm tsx scripts/t1-4-rate-limits.ts
 */

import { auth } from 'twitter-api-sdk';
import { loadConfig, validateConfig } from '../../src/lib/config.js';
import { loadTokens, saveTokens } from '../../src/lib/tokens.js';

async function getAuthClient(config: ReturnType<typeof loadConfig>) {
  const storedTokens = loadTokens();
  const authClient = new auth.OAuth2User({
    client_id: config.xClientId,
    client_secret: config.xClientSecret,
    callback: 'http://127.0.0.1:3000/callback',
    scopes: ['bookmark.read', 'bookmark.write', 'tweet.read', 'users.read', 'offline.access'],
    token: {
      access_token: storedTokens?.accessToken ?? config.xAccessToken,
      refresh_token: storedTokens?.refreshToken ?? config.xRefreshToken,
      expires_at: storedTokens?.expiresAt,
    },
  });

  if (authClient.isAccessTokenExpired()) {
    console.log('Refreshing expired token...');
    const { token } = await authClient.refreshAccessToken();
    if (token.access_token && token.refresh_token) {
      saveTokens({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_at,
      });
    }
  }

  return authClient;
}

interface RateLimitInfo {
  endpoint: string;
  method: string;
  status: number;
  limit: string | null;
  remaining: string | null;
  reset: string | null;
  resetTime: string | null;
  windowMs: number | null;
  allHeaders: Record<string, string>;
}

async function probeEndpoint(
  url: string,
  method: string,
  headers: { Authorization: string },
): Promise<RateLimitInfo> {
  const response = await fetch(url, { method, headers });

  const limit = response.headers.get('x-rate-limit-limit');
  const remaining = response.headers.get('x-rate-limit-remaining');
  const reset = response.headers.get('x-rate-limit-reset');

  let resetTime: string | null = null;
  let windowMs: number | null = null;
  if (reset) {
    const resetMs = Number(reset) * 1000;
    resetTime = new Date(resetMs).toISOString();
    windowMs = resetMs - Date.now();
  }

  // Capture all rate-limit-related headers
  const allHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.startsWith('x-rate-limit') || key.startsWith('x-app-limit') || key === 'retry-after') {
      allHeaders[key] = value;
    }
  });

  // Consume body to avoid connection issues
  await response.text();

  return {
    endpoint: url.replace(/https:\/\/api\.twitter\.com/, ''),
    method,
    status: response.status,
    limit,
    remaining,
    reset,
    resetTime,
    windowMs,
    allHeaders,
  };
}

async function main() {
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Config errors:', errors);
    process.exit(1);
  }

  const authClient = await getAuthClient(config);
  const userId = config.xUserId;
  const headers = await authClient.getAuthHeader();

  console.log('========================================');
  console.log('T1.4: Current Rate Limits from Headers');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log(`  User ID:   ${userId}`);
  console.log('========================================');

  // Need a tweet ID for the tweet lookup test - fetch one from bookmarks
  let sampleTweetId: string | null = null;

  const endpoints: Array<{ name: string; url: string; method: string }> = [
    {
      name: 'Bookmarks (global)',
      url: `https://api.twitter.com/2/users/${userId}/bookmarks?max_results=1`,
      method: 'GET',
    },
    {
      name: 'Folder list',
      url: `https://api.twitter.com/2/users/${userId}/bookmarks/folders?max_results=1`,
      method: 'GET',
    },
    {
      name: 'User lookup (me)',
      url: 'https://api.twitter.com/2/users/me',
      method: 'GET',
    },
  ];

  const results: RateLimitInfo[] = [];

  for (const ep of endpoints) {
    console.log(`\n--- ${ep.name} ---`);
    console.log(`  ${ep.method} ${ep.url}`);

    const result = await probeEndpoint(ep.url, ep.method, headers);
    results.push(result);

    console.log(`  Status: ${result.status}`);
    console.log(`  Limit:     ${result.limit ?? '(not present)'}`);
    console.log(`  Remaining: ${result.remaining ?? '(not present)'}`);
    console.log(`  Reset:     ${result.reset ?? '(not present)'}${result.resetTime ? ` (${result.resetTime})` : ''}`);
    console.log(`  Window:    ${result.windowMs ? `${Math.ceil(result.windowMs / 1000)}s remaining` : '(unknown)'}`);

    if (Object.keys(result.allHeaders).length > 0) {
      console.log('  All rate headers:');
      for (const [k, v] of Object.entries(result.allHeaders)) {
        console.log(`    ${k}: ${v}`);
      }
    }

    // Grab a tweet ID from bookmarks response for tweet lookup test
    if (ep.name === 'Bookmarks (global)' && result.status === 200) {
      try {
        const bookmarksUrl = ep.url;
        const bookmarksResponse = await fetch(bookmarksUrl, { headers });
        const bookmarksData = await bookmarksResponse.json();
        sampleTweetId = bookmarksData.data?.[0]?.id ?? null;
      } catch {
        // Already consumed body above, fetch again
      }
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  // Tweet lookup (if we have a tweet ID)
  if (!sampleTweetId) {
    // Try fetching bookmarks again for a tweet ID
    try {
      const bookmarksUrl = `https://api.twitter.com/2/users/${userId}/bookmarks?max_results=1`;
      const bookmarksResponse = await fetch(bookmarksUrl, { headers });
      const bookmarksData = await bookmarksResponse.json();
      sampleTweetId = bookmarksData.data?.[0]?.id ?? null;
    } catch {
      // ignore
    }
  }

  if (sampleTweetId) {
    const tweetEp = {
      name: 'Tweet lookup',
      url: `https://api.twitter.com/2/tweets/${sampleTweetId}?tweet.fields=created_at`,
      method: 'GET',
    };

    console.log(`\n--- ${tweetEp.name} ---`);
    console.log(`  ${tweetEp.method} ${tweetEp.url}`);

    const result = await probeEndpoint(tweetEp.url, tweetEp.method, headers);
    results.push(result);

    console.log(`  Status: ${result.status}`);
    console.log(`  Limit:     ${result.limit ?? '(not present)'}`);
    console.log(`  Remaining: ${result.remaining ?? '(not present)'}`);
    console.log(`  Reset:     ${result.reset ?? '(not present)'}${result.resetTime ? ` (${result.resetTime})` : ''}`);
    console.log(`  Window:    ${result.windowMs ? `${Math.ceil(result.windowMs / 1000)}s remaining` : '(unknown)'}`);

    if (Object.keys(result.allHeaders).length > 0) {
      console.log('  All rate headers:');
      for (const [k, v] of Object.entries(result.allHeaders)) {
        console.log(`    ${k}: ${v}`);
      }
    }
  } else {
    console.log('\n--- Tweet lookup ---');
    console.log('  Skipped: no bookmark found to use as sample tweet ID');
  }

  // --- Summary Table ---
  console.log('\n========================================');
  console.log('Summary');
  console.log('========================================');
  console.log('');
  console.log('| Endpoint | Limit | Remaining | Window Reset |');
  console.log('|----------|-------|-----------|--------------|');

  for (const r of results) {
    const window = r.windowMs ? `${Math.ceil(r.windowMs / 1000)}s` : '?';
    console.log(`| ${r.endpoint} | ${r.limit ?? '?'} | ${r.remaining ?? '?'} | ${window} |`);
  }

  // --- Comparison with documented limits ---
  console.log('\n========================================');
  console.log('Comparison with Assessment Document');
  console.log('========================================');
  console.log('');
  console.log('Documented expected limits (from X API docs):');
  console.log('  Post lookups:        450-3,500 req/15min per app');
  console.log('  User lookups:        300 req/15min per app');
  console.log('  Bookmarks:           (check above)');
  console.log('  Folders:             (check above)');
  console.log('');
  console.log('Compare the "Limit" column above with these documented values.');
  console.log('The old limits were 1-5 req/15min. If current limits are 100+,');
  console.log('the Phase 2 rate limiter simplification is confirmed correct.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
