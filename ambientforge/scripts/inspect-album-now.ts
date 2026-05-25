import { getDb } from '../src/lib/db';
import * as albumsRepo from '../src/lib/repos/albums';
const a = albumsRepo.get('01KQCG9YSY5P0V7S1XSAYJ8QA9', getDb());
console.log('status:', a?.status);
console.log('distrokidStatus:', a?.distrokidStatus);
console.log('videoStatus:', a?.videoStatus);
console.log('videoProgressPct:', a?.videoProgressPct);
console.log('lastError:', a?.lastError);
