process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED_REJECTION', err && err.message || err);
  // Don’t crash the workflow; just print empty data and exit normally
  try { process.stdout.write('[]'); } catch (_) {}
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err && err.message || err);
  try { process.stdout.write('[]'); } catch (_) {}
  process.exit(0);
});
