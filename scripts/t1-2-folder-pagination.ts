#!/usr/bin/env tsx
/**
 * T1.2 - Test folder list pagination
 *
 * Tests whether GET /2/users/:id/bookmarks/folders
 * now supports pagination via meta.next_token.
 *
 * Previously: returned max ~20 folders with no pagination.
 * Expected: may now support pagination under pay-per-usage.
 *
 * Usage: pnpm tsx scripts/t1-2-folder-pagination.ts
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

function printRateLimitHeaders(response: Response) {
  const remaining = response.headers.get('x-rate-limit-remaining');
  const limit = response.headers.get('x-rate-limit-limit');
  const reset = response.headers.get('x-rate-limit-reset');
  console.log('\n  Rate limit headers:');
  console.log(`    x-rate-limit-limit:     ${limit ?? '(not present)'}`);
  console.log(`    x-rate-limit-remaining: ${remaining ?? '(not present)'}`);
  console.log(`    x-rate-limit-reset:     ${reset ? `${reset} (${new Date(Number(reset) * 1000).toISOString()})` : '(not present)'}`);
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

  // --- Test A: Fetch folders with max_results ---
  console.log('========================================');
  console.log('Test A: Folder list with max_results=100');
  console.log('========================================');

  const url = `https://api.twitter.com/2/users/${userId}/bookmarks/folders?max_results=100`;
  console.log(`  GET ${url}`);

  const response = await fetch(url, { headers });
  const body = await response.text();

  console.log(`  Status: ${response.status}`);
  printRateLimitHeaders(response);
  console.log(`  Body: ${body}`);

  if (response.status !== 200) {
    console.log('\n  Request failed - cannot test pagination');
    return;
  }

  const data = JSON.parse(body);
  const folders = data.data ?? [];
  const meta = data.meta ?? {};

  console.log(`\n  Folders returned: ${folders.length}`);
  console.log(`  meta.result_count: ${meta.result_count ?? '(not present)'}`);
  console.log(`  meta.next_token:   ${meta.next_token ?? '(not present)'}`);

  for (const f of folders) {
    console.log(`    - ${f.name} (id: ${f.id})`);
  }

  // --- Test B: If next_token exists, fetch page 2 ---
  if (meta.next_token) {
    console.log('\n========================================');
    console.log('Test B: Folder list page 2 (using next_token)');
    console.log('========================================');

    const page2Url = `https://api.twitter.com/2/users/${userId}/bookmarks/folders?max_results=100&pagination_token=${meta.next_token}`;
    console.log(`  GET ${page2Url}`);

    const page2Response = await fetch(page2Url, { headers });
    const page2Body = await page2Response.text();

    console.log(`  Status: ${page2Response.status}`);
    printRateLimitHeaders(page2Response);
    console.log(`  Body: ${page2Body}`);
  }

  // --- Test C: Small page size to force pagination ---
  console.log('\n========================================');
  console.log('Test C: Folder list with max_results=1 (force pagination)');
  console.log('========================================');

  const smallUrl = `https://api.twitter.com/2/users/${userId}/bookmarks/folders?max_results=1`;
  console.log(`  GET ${smallUrl}`);

  const smallResponse = await fetch(smallUrl, { headers });
  const smallBody = await smallResponse.text();

  console.log(`  Status: ${smallResponse.status}`);
  printRateLimitHeaders(smallResponse);
  console.log(`  Body: ${smallBody}`);

  if (smallResponse.status === 200) {
    const smallData = JSON.parse(smallBody);
    const smallMeta = smallData.meta ?? {};
    console.log(`\n  Folders returned: ${(smallData.data ?? []).length}`);
    console.log(`  meta.next_token:  ${smallMeta.next_token ?? '(not present)'}`);
  }

  // --- Analysis ---
  console.log('\n========================================');
  console.log('Analysis');
  console.log('========================================');

  const hasNextToken = meta.next_token !== undefined;
  const totalFolders = folders.length;

  if (hasNextToken) {
    console.log('  RESULT: Folder list endpoint SUPPORTS pagination (next_token present)');
    console.log('  -> Update docs/issues/folder-pagination.md');
  } else if (totalFolders > 20) {
    console.log(`  RESULT: Returned ${totalFolders} folders without pagination`);
    console.log('  -> Pagination may not be needed if all folders returned at once');
  } else {
    console.log(`  RESULT: ${totalFolders} folders returned, no next_token`);
    console.log('  -> Inconclusive: need 20+ folders to truly test pagination');
    console.log('  -> Check Test C (max_results=1) above for forced pagination behavior');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
