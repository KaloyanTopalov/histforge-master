const fs = require('node:fs');
const path = require('node:path');
const TMP = process.env.TEMP || 'C:/Users/User/AppData/Local/Temp';

const rms = (name) => {
  const b = fs.readFileSync(path.join(TMP, name));
  const n = b.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = b.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.round(Math.sqrt(sum / n));
};

const zc = (name) => {
  const b = fs.readFileSync(path.join(TMP, name));
  const n = b.length / 2;
  let count = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const s = b.readInt16LE(i * 2);
    if ((s >= 0) !== (prev >= 0)) count++;
    prev = s;
  }
  return Math.round(count / (n / 16000));
};

console.log('=== RMS (volume) ===');
console.log('final.mp4   :', rms('final-audio.raw'));
console.log('concat.wav  :', rms('concat-audio.raw'));
console.log('broll       :', rms('broll-audio.raw'));
console.log('=== Zero-crossings per second (frequency proxy; ~440 ≈ 220Hz tone) ===');
console.log('final.mp4   :', zc('final-audio.raw'));
console.log('concat.wav  :', zc('concat-audio.raw'));
console.log('broll       :', zc('broll-audio.raw'));
