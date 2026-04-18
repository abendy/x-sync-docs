import { auth } from 'twitter-api-sdk';
import { loadConfig } from '../../src/lib/config.js';
import { loadTokens } from '../../src/lib/tokens.js';

async function main() {
  const config = loadConfig();
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

  const headers = await authClient.getAuthHeader();
  const url = `https://api.twitter.com/2/users/${config.xUserId}/bookmarks/folders?max_results=1`;
  const res = await fetch(url, { headers });

  console.log('Status:', res.status);
  console.log('x-rate-limit-limit:', res.headers.get('x-rate-limit-limit'));
  console.log('x-rate-limit-remaining:', res.headers.get('x-rate-limit-remaining'));
  const reset = res.headers.get('x-rate-limit-reset');
  if (reset) {
    const resetMs = Number(reset) * 1000;
    const waitSec = Math.ceil((resetMs - Date.now()) / 1000);
    console.log('x-rate-limit-reset:', reset, `(${new Date(resetMs).toISOString()})`);
    console.log('Wait:', `${waitSec}s`);
  }
}

main().catch(console.error);
