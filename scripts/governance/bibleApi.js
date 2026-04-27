#!/usr/bin/env node

/**
 * Offline-capable attestation helper for venom-network.
 * If VERSE_CACHE_PATH is set in .env, it reads verses from a local JSON file.
 * Otherwise it attempts to fetch from API.Bible (requires network).
 */

require('dotenv').config();
const { createHash } = require('crypto');
const fs = require('fs');

// ============================================================
// Configuration
// ============================================================

const NODE_ADDRESS = process.env.NODE_ADDRESS || '0x4A735A58f9b7B4F3C6eD2cD7a1F5E8F42b0D9c1A';
const BASE_URL = 'https://rest.api.bible/v1';
const BIBLE_ID = process.env.BIBLE_ID || 'de4e12af7f28f599-01';
const VERSE_CACHE_PATH = process.env.VERSE_CACHE_PATH || '';

let verseCache = null;
if (VERSE_CACHE_PATH) {
  try {
    verseCache = JSON.parse(fs.readFileSync(VERSE_CACHE_PATH, 'utf-8'));
    console.log(`Loaded verse cache from ${VERSE_CACHE_PATH} (${verseCache.bibleName})`);
  } catch (err) {
    console.error('Failed to load verse cache:', err.message);
    process.exit(1);
  }
}

// ============================================================
// Creed definitions
// ============================================================

const CREEDS = [
  {
    index: 0,
    name: 'Son of God',
    statement: 'I believe Jesus is the Son of God, true God from true God.',
    references: [
      { book: 'JHN', chapter: 1, verse: 14 },
      { book: 'JHN', chapter: 1, verse: 18 },
      { book: 'HEB', chapter: 1, verse: 3 }
    ]
  },
  {
    index: 1,
    name: 'Messiah (Christ) in human form',
    statement: 'I believe Jesus is the Christ, the Messiah, who came in the flesh.',
    references: [
      { book: 'JHN', chapter: 1, verse: 14 },
      { book: '1JN', chapter: 4, verse: 2 },
      { book: 'LUK', chapter: 2, verse: 11 }
    ]
  },
  {
    index: 2,
    name: 'Resurrected from the dead',
    statement: 'I believe Jesus rose bodily from the dead on the third day.',
    references: [
      { book: '1CO', chapter: 15, verse: 3 },
      { book: '1CO', chapter: 15, verse: 4 },
      { book: 'ROM', chapter: 10, verse: 9 }
    ]
  },
  {
    index: 3,
    name: 'Lord',
    statement: 'Jesus is Lord, to the glory of God the Father.',
    references: [
      { book: 'PHP', chapter: 2, verse: 10 },
      { book: 'PHP', chapter: 2, verse: 11 },
      { book: 'ROM', chapter: 10, verse: 9 }
    ]
  }
];

// ============================================================
// Verse fetching helpers
// ============================================================

function getVerseId(book, chapter, verse) {
  return `${book}.${chapter}.${verse}`;
}

async function fetchVerseOnline(book, chapter, verse) {
  const verseId = getVerseId(book, chapter, verse);
  const url = `${BASE_URL}/bibles/${BIBLE_ID}/verses/${verseId}?content-type=text&include-verse-numbers=false`;

  const API_KEY = process.env.BIBLE_API_KEY;
  if (!API_KEY) throw new Error('Missing BIBLE_API_KEY');

  const response = await fetch(url, {
    headers: { 'api-key': API_KEY, 'Accept': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`API error for ${verseId}: ${response.status}`);
  }
  const data = await response.json();
  return data.data.content.trim();
}

function fetchVerseLocal(book, chapter, verse) {
  const verseId = getVerseId(book, chapter, verse);
  const text = verseCache.verses[verseId];
  if (!text) throw new Error(`Verse not in cache: ${verseId}`);
  return text;
}

async function fetchAllVerses(references) {
  const results = [];
  for (const ref of references) {
    let text;
    if (verseCache) {
      text = fetchVerseLocal(ref.book, ref.chapter, ref.verse);
    } else {
      text = await fetchVerseOnline(ref.book, ref.chapter, ref.verse);
    }
    results.push({ ref: `${ref.book} ${ref.chapter}:${ref.verse}`, text });
  }
  return results;
}

// ============================================================
// Hashing (keccak256)
// ============================================================

function keccak256(message) {
  return '0x' + createHash('sha3-256').update(message).digest('hex');
}

// ============================================================
// Attestation builder
// ============================================================

async function buildAttestation(creed) {
  const verses = await fetchAllVerses(creed.references);
  const verseTexts = verses.map(v => v.text).join(' | ');
  const attestationString = `${NODE_ADDRESS} | ${creed.statement} | ${verseTexts}`;
  const hash = keccak256(attestationString);
  return {
    creedIndex: creed.index,
    creedName: creed.name,
    statement: creed.statement,
    verses,
    attestationString,
    hash
  };
}

// ============================================================
// Main
// ============================================================

(async () => {
  if (verseCache) {
    console.log('Using local verse cache (no network required)');
  } else {
    console.log(`Fetching verses from API.Bible (${BIBLE_ID})`);
  }

  const results = [];
  for (const creed of CREEDS) {
    try {
      const attestation = await buildAttestation(creed);
      results.push(attestation);
      console.log(`✅ ${creed.name} – ${attestation.verses.length} verses`);
    } catch (err) {
      console.error(`❌ ${creed.name} failed:`, err.message);
    }
  }

  console.log('\n=== Attestation Payload (JSON) ===\n');
  console.log(JSON.stringify(results, null, 2));
  console.log('\n=== Done ===');
})();