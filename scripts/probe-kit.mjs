// Local test for the Kit integration. Tags a throwaway email into one of
// Michelle's Kit tags so you can confirm the key works and the subscriber shows
// up (with the right tag) in her Kit account.
//
// Usage (needs KIT_API_KEY in the env file):
//   node --env-file=.env.local scripts/probe-kit.mjs you+test@example.com new-client
//   node --env-file=.env.local scripts/probe-kit.mjs you+test@example.com halo-interested
//
// Tag names: new-client | halo-interested | halo-agreement  (default: new-client)
// Writes to Michelle's live Kit account — use a throwaway/self address.

import {
  tagSubscriber,
  KIT_READY,
  KIT_TAG_NEW_CLIENT,
  KIT_TAG_HALO_INTERESTED,
  KIT_TAG_HALO_AGREEMENT,
} from '../lib/kit.mjs';

const TAGS = {
  'new-client': KIT_TAG_NEW_CLIENT,
  'halo-interested': KIT_TAG_HALO_INTERESTED,
  'halo-agreement': KIT_TAG_HALO_AGREEMENT,
};

async function main() {
  const email = process.argv[2];
  const tagName = (process.argv[3] || 'new-client').toLowerCase();

  if (!email) {
    console.error('Usage: node --env-file=.env.local scripts/probe-kit.mjs <email> [new-client|halo-interested|halo-agreement]');
    process.exit(1);
  }
  const tagId = TAGS[tagName];
  if (!tagId) {
    console.error(`Unknown tag "${tagName}". Use one of: ${Object.keys(TAGS).join(', ')}`);
    process.exit(1);
  }

  console.log(`KIT key present: ${KIT_READY ? 'yes' : 'NO (set KIT_API_KEY)'}`);
  console.log(`Tagging ${email} -> ${tagName} (tag ${tagId})...\n`);

  const result = await tagSubscriber(tagId, {
    email,
    firstName: 'Probe',
    lastName: 'Test',
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.log('\nNot tagged. If skipped=no-kit-key, add Michelle\'s KIT_API_KEY to the env file first.');
    process.exit(result.skipped ? 0 : 1);
  }
  console.log('\nSuccess — check the subscriber in Michelle\'s Kit account for the tag.');
}

main().catch((err) => {
  console.error('probe-kit threw:', err);
  process.exit(1);
});
