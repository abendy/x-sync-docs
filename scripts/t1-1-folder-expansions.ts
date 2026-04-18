#!/usr/bin/env tsx
/**
 * T1.1 - Test folder endpoint with expansions/fields
 *
 * Tests whether GET /2/users/:id/bookmarks/folders/:folder_id
 * now accepts tweet.fields, user.fields, media.fields, and expansions params.
 *
 * Previously: folder endpoint rejected query params and returned IDs only.
 * Expected: under pay-per-usage, it may now support full expansions.
 *
 * Usage: pnpm tsx scripts/t1-1-folder-expansions.ts [folder_id]
 *   If no folder_id provided, fetches folders first and uses the first one.
 */

import { auth } from 'twitter-api-sdk';
import { loadConfig, validateConfig } from '../../src/lib/config.js';
import { loadTokens, saveTokens } from '../../src/lib/tokens.js';

const TWEET_FIELDS = 'created_at,author_id,text,public_metrics,entities,lang,source,conversation_id';
const USER_FIELDS = 'created_at,description,name,username,profile_image_url,public_metrics';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text,width,height';
const EXPANSIONS = 'author_id,attachments.media_keys';

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

function printRateLimitHeaders(response: Response) {
  const remaining = response.headers.get('x-rate-limit-remaining');
  const limit = response.headers.get('x-rate-limit-limit');
  const reset = response.headers.get('x-rate-limit-reset');
  console.log('\n  Rate limit headers:');
  console.log(`    x-rate-limit-limit:     ${limit ?? '(not present)'}`);
  console.log(`    x-rate-limit-remaining: ${remaining ?? '(not present)'}`);
  console.log(`    x-rate-limit-reset:     ${reset ? `${reset} (${new Date(Number(reset) * 1000).toISOString()})` : '(not present)'}`);
}

async function getFolderId(authClient: auth.OAuth2User, userId: string): Promise<string | null> {
  console.log('\n--- Fetching folders to find a test folder ---');
  const url = `https://api.twitter.com/2/users/${userId}/bookmarks/folders?max_results=100`;
  const headers = await authClient.getAuthHeader();
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text();
    console.log(`  Folders request failed: ${response.status} ${body}`);
    return null;
  }

  const data = await response.json();
  const folders = data.data ?? [];

  if (folders.length === 0) {
    console.log('  No folders found. Create a bookmark folder with at least one bookmark to test.');
    return null;
  }

  console.log(`  Found ${folders.length} folder(s):`);
  for (const f of folders) {
    console.log(`    - ${f.name} (id: ${f.id})`);
  }

  return folders[0].id;
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
  const folderId = process.argv[2] ?? (await getFolderId(authClient, userId));

  if (!folderId) {
    console.error('\nNo folder ID available. Pass one as argument or create a bookmark folder.');
    process.exit(1);
  }

  console.log(`\nUsing folder ID: ${folderId}`);
  const headers = await authClient.getAuthHeader();

  // --- Test A: Folder endpoint WITHOUT expansions (baseline) ---
  console.log('\n========================================');
  console.log('Test A: Folder endpoint WITHOUT expansions (baseline)');
  console.log('========================================');

  const baselineUrl = `https://api.twitter.com/2/users/${userId}/bookmarks/folders/${folderId}`;
  console.log(`  GET ${baselineUrl}`);

  const baselineResponse = await fetch(baselineUrl, { headers });
  const baselineBody = await baselineResponse.text();

  console.log(`  Status: ${baselineResponse.status}`);
  printRateLimitHeaders(baselineResponse);
  console.log(`  Body: ${baselineBody}`);

  // --- Test B: Folder endpoint WITH expansions ---
  console.log('\n========================================');
  console.log('Test B: Folder endpoint WITH tweet.fields + user.fields + expansions');
  console.log('========================================');

  const expandedUrl = new URL(`https://api.twitter.com/2/users/${userId}/bookmarks/folders/${folderId}`);
  expandedUrl.searchParams.set('tweet.fields', TWEET_FIELDS);
  expandedUrl.searchParams.set('user.fields', USER_FIELDS);
  expandedUrl.searchParams.set('media.fields', MEDIA_FIELDS);
  expandedUrl.searchParams.set('expansions', EXPANSIONS);
  expandedUrl.searchParams.set('max_results', '5');

  console.log(`  GET ${expandedUrl.toString()}`);

  const expandedResponse = await fetch(expandedUrl.toString(), { headers });
  const expandedBody = await expandedResponse.text();

  console.log(`  Status: ${expandedResponse.status}`);
  printRateLimitHeaders(expandedResponse);
  console.log(`  Body: ${expandedBody}`);

  // --- Analysis ---
  console.log('\n========================================');
  console.log('Analysis');
  console.log('========================================');

  if (expandedResponse.status === 200) {
    try {
      const parsed = JSON.parse(expandedBody);
      const hasIncludes = 'includes' in parsed;
      const hasUsers = parsed.includes?.users?.length > 0;
      const hasText = parsed.data?.[0]?.text !== undefined;

      if (hasIncludes && hasUsers && hasText) {
        console.log('  RESULT: Folder endpoint NOW SUPPORTS expansions!');
        console.log('  -> Stub/partial pattern is UNNECESSARY');
        console.log('  -> Enrichment workflow is UNNECESSARY');
        console.log('  -> Proceed with Phase 3 cleanup (T3.1-T3.8)');
      } else if (hasText) {
        console.log('  RESULT: Folder endpoint returns tweet fields but no includes');
        console.log('  -> Partial support - needs further investigation');
      } else {
        console.log('  RESULT: 200 OK but still returns IDs only (params silently ignored)');
        console.log('  -> Stub/partial pattern is STILL NEEDED');
        console.log('  -> Proceed with Phase 3 alternative (T3.9-T3.11)');
      }
    } catch {
      console.log(`  RESULT: Could not parse response body`);
    }
  } else if (expandedResponse.status === 400) {
    console.log('  RESULT: Folder endpoint REJECTS expansion params (400 error)');
    console.log('  -> Stub/partial pattern is STILL NEEDED');
    console.log('  -> Proceed with Phase 3 alternative (T3.9-T3.11)');
  } else {
    console.log(`  RESULT: Unexpected status ${expandedResponse.status} - manual review needed`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
