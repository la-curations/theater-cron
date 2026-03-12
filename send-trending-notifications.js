
const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * TRENDING NOTIFICATION SCRIPT
 * 
 * This script fetches the trending movie of the week for EVERY region 
 * and sends a push notification to that region's FCM topic.
 */

// 1. INITIALIZE FIREBASE ADMIN
// Expects FIREBASE_SERVICE_ACCOUNT environment variable with the JSON string content
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is missing.');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error.message);
  process.exit(1);
}

const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error('❌ TMDB_API_KEY environment variable is missing.');
  process.exit(1);
}

// --- CONFIGURATION ---
// 1. Define countries where you actually have users (e.g., ['IN', 'US', 'GB'])
// If empty [], it will attempt to fetch for ALL regions in region.json
const TARGET_REGIONS = ['IN', 'US']; 

// 2. Decide if you want to send a "Global Trending" notification to everyone else
// or as a fallback if a regional trending movie isn't found.
const ENABLE_GLOBAL_FALLBACK = true;
// ---------------------

/**
 * Helper to fetch regional trending
 * Using /discover/movie with region and popularity to get "What's trending locally"
 */
async function getTopRegionalMovie(regionCode) {
  try {
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - 7);
    
    const formattedLastWeek = lastWeek.toISOString().split('T')[0];

    const response = await axios.get('https://api.themoviedb.org/3/discover/movie', {
      params: {
        api_key: TMDB_API_KEY,
        region: regionCode,
        sort_by: 'popularity.desc',
        'primary_release_date.gte': formattedLastWeek,
        include_adult: false,
        page: 1
      },
      timeout: 10000
    });

    return response.data.results[0]; // Take the #1 most popular
  } catch (error) {
    console.error(`  - Error fetching for ${regionCode}:`, error.message);
    return null;
  }
}

/**
 * Fetch #1 Global Trending Movie for the week
 */
async function getGlobalTrendingMovie() {
  try {
    const response = await axios.get(`https://api.themoviedb.org/3/trending/movie/week`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 10000
    });
    return response.data.results[0];
  } catch (error) {
    console.error('  - Error fetching global trending:', error.message);
    return null;
  }
}

/**
 * Generic function to send notification to a topic
 */
async function sendToTopic(topic, movie, regionName = '') {
  try {
    const message = {
      notification: {
        title: regionName ? `Trending in ${regionName}! 🍿` : `Weekly Trending! 🍿`,
        body: `Don't miss "${movie.title}" — it's the hit for this week.`,
        image: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : undefined
      },
      data: {
        screen: 'MovieDetails',
        movieId: movie.id.toString(),
        imageUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
        channelId: 'la_theater'
      },
      topic: topic,
      android: {
        priority: 'high',
        notification: {
          channelId: 'la_theater',
          icon: 'ic_notification',
          color: '#FFFFFF'
        }
      },
      apns: {
        payload: {
          aps: {
            badge: 1,
            sound: 'default',
            mutableContent: true
          }
        }
      }
    };

    await admin.messaging().send(message);
    console.log(`✅ Sent to ${topic}: ${movie.title}`);
    return true;
  } catch (error) {
    console.error(`❌ FCM Failed for ${topic}:`, error.message);
    return false;
  }
}

async function run() {
  const regionsPath = path.join(__dirname, 'region.json');
  
  if (!fs.existsSync(regionsPath)) {
    console.error('❌ region.json not found in script directory!');
    process.exit(1);
  }

  const allRegions = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
  
  // Decide which regions to process individually
  const regionsToProcess = TARGET_REGIONS.length > 0 
    ? allRegions.filter(r => TARGET_REGIONS.includes(r.iso_3166_1))
    : allRegions;

  console.log(`🚀 Starting notification cycle for ${regionsToProcess.length} targeted regions...`);

  const results = {
    sent: 0,
    skipped: 0,
    errors: 0
  };

  // 1. Process Targeted Regions
  for (let i = 0; i < regionsToProcess.length; i += 5) {
    const batch = regionsToProcess.slice(i, i + 5);
    
    await Promise.all(batch.map(async (region) => {
      const regionCode = region.iso_3166_1;
      const movie = await getTopRegionalMovie(regionCode);

      if (movie) {
        const success = await sendToTopic(regionCode, movie, region.english_name);
        if (success) results.sent++; else results.errors++;
      } else {
        results.skipped++;
      }
    }));

    if (i + 5 < regionsToProcess.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 2. Global Fallback
  // If we only target a few countries, we can send a "Global Trending" to the 'all' or 'trending' topics
  // to cover everyone else in a single API call.
  if (ENABLE_GLOBAL_FALLBACK) {
    process.stdout.write('\n🌍 Fetching global trending fallback...');
    const globalMovie = await getGlobalTrendingMovie();
    if (globalMovie) {
      console.log(` Top: ${globalMovie.title}`);
      // Notify the 'trending' topic (or 'all')
      await sendToTopic('trending', globalMovie, "Everywhere");
      results.sent++;
    } else {
      console.log(' Failed to fetch global trending.');
    }
  }

  console.log('\n--- Weekly Sync Complete ---');
  console.log(`Sent: ${results.sent}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Errors: ${results.errors}`);
  console.log('----------------------------');
}

run().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
