import { closeConnections, getDatabase, ingestionRepository } from '@portfolio-pilot/db';
import { assertFixtureEnvironment, fixtureArticle, injectFixture } from './fixture.js';
import { initTelemetry, inSpan } from '@portfolio-pilot/observability';
// Same ingestion path as provider polling, so the article's trace starts here (exporters opt-in).
const telemetry = initTelemetry({ serviceName: 'portfolio-pilot-ingestion-fixture' });
try {
  assertFixtureEnvironment(process.env); // Before any connection or mutation, including production.
  const [id = 'lesson16', revision = '1', publishedAt] = process.argv.slice(2);
  fixtureArticle(id, Number(revision), publishedAt ?? new Date().toISOString());
  const db = await getDatabase(process.env.DATABASE_URL!);
  // Store the first timestamp in the schedule so repeated CLI calls have identical fingerprints.
  const state = await ingestionRepository(db).initialize(`dev-fixture-clock:${id}`, publishedAt ? new Date(publishedAt) : new Date());
  await inSpan('ingestion.pass', { 'pp.job.id': 'development-fixture' }, () => injectFixture(ingestionRepository(db), { id, revision: Number(revision), publishedAt: publishedAt ?? state.mockStartAt.toISOString() }), { parent: null });
  console.log(`Fixture ${id} revision ${revision} committed through ingestion; outbox dispatch delivers it.`);
} catch { console.error('Fixture injection failed; check the fixture inputs and database availability.'); process.exitCode = 1; }
finally { await closeConnections(); await telemetry.shutdown(); }
