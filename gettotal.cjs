const c = require('.\\coverage\\coverage-final.json');
let totalS = 0, totalF = 0, totalB = 0, hitS = 0, hitF = 0, hitB = 0;
for (const key of Object.keys(c)) {
  const f = c[key];
  if (!f.s) continue;
  const sKeys = Object.keys(f.s);
  const fKeys = Object.keys(f.f);
  const bKeys = Object.keys(f.b);
  totalS += sKeys.length;
  totalF += fKeys.length;
  totalB += bKeys.length;
  for (const k of sKeys) if (f.s[k] > 0) hitS++;
  for (const k of fKeys) if (f.f[k] > 0) hitF++;
  for (const k of bKeys) { const arr = f.b[k]; if (arr && arr.length === 2 && (arr[0] + arr[1]) > 0) hitB++; }
}
console.log(`statements: ${hitS}/${totalS} = ${(hitS/totalS*100).toFixed(2)}%`);
console.log(`functions: ${hitF}/${totalF} = ${(hitF/totalF*100).toFixed(2)}%`);
console.log(`branches: ${hitB}/${totalB} = ${(hitB/totalB*100).toFixed(2)}%`);
console.log(`lines: ${hitS}/${totalS} = ${(hitS/totalS*100).toFixed(2)}%`);