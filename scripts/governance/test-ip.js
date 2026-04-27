// test-ip.js
require('dotenv').config();
const API_KEY = process.env.BIBLE_API_KEY;
if (!API_KEY) process.exit(1);

const BASE_URL = 'https://44.226.72.246/v1';

fetch(`${BASE_URL}/bibles`, {
  headers: {
    'api-key': API_KEY,
    'Accept': 'application/json',
    'Host': 'rest.api.bible'   // Important: send the correct Host header
  }
})
.then(async res => {
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response body:', text.substring(0, 300) + '...');
})
.catch(err => console.error('Fetch failed:', err.message));