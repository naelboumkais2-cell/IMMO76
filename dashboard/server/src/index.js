import express from 'express';
import cors from 'cors';
import { db, initDb } from './db.js';
import { scraperRouter } from './routes/scraper.js';
import { portailsRouter } from './routes/portails.js';
import { annoncesRouter } from './routes/annonces.js';
import { logsRouter } from './routes/logs.js';
import { rescraperRechercheFavorite } from './services/orchestrator.js';
import { mode as hubiflowMode } from './integrations/hubiflowRouter.js';

// Init Postgres database
initDb().catch(console.error);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api/scraper', scraperRouter);
app.use('/api/portails', portailsRouter);
app.use('/api/annonces', annoncesRouter);
app.use('/api/logs', logsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/hubiflow-mode', (req, res) => res.json({ mode: hubiflowMode }));

// Vercel Cron Endpoint replacing the setInterval
app.get('/api/cron', async (req, res) => {
    try {
        const dues = await db
            .prepare(
                `SELECT * FROM recherches
                 WHERE frequence_minutes IS NOT NULL
                 AND (
                   derniere_execution_le IS NULL
                   OR EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - derniere_execution_le)) >= frequence_minutes * 60
                 )`
            )
            .all();

        let nbExecuted = 0;
        for (const recherche of dues) {
            try {
                await rescraperRechercheFavorite(recherche);
                nbExecuted++;
            } catch (e) {
                console.error('[cron] échec du scraping programmé pour', recherche.id, ':', e.message);
            }
        }
        res.json({ success: true, count: nbExecuted });
    } catch (e) {
        console.error('[cron] erreur globale:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4100;
    app.listen(PORT, () => {
        console.log(`[dashboard-server] démarré sur http://localhost:${PORT}`);
    });
}

// For Vercel serverless functions
export default app;
