/* STEP 8 fills this. Scaffold polls /api/health. */
async function tick() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    console.log('health', j);
  } catch (e) {
    console.warn(e);
  }
}
tick();
setInterval(tick, 15000);
