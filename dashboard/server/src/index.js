import express from 'express';
import cors from 'cors';
import { db } from './db.js';
import { scraperRouter } from './routes/scraper.js';
import { portailsRouter } from './routes/portails.js';
import { annoncesRouter } from './routes/annonces.js';
import { logsRouter } from './routes/logs.js';
import { rescraperRechercheFavorite } from './services/orchestrator.js';
import { mode as hubiflowMode } from './integrations/hubiflowRouter.js';

const app = express();
app.use(cors());
// Les vrais lots Otaree (documents, images, métadonnées) dépassent largement la limite par
// défaut d'Express (100kb) — même limite que Ubiflow-Auto-API/server.js.
app.use(express.json({ limit: '50mb' }));

app.use('/api/scraper', scraperRouter);
app.use('/api/portails', portailsRouter);
app.use('/api/annonces', annoncesRouter);
app.use('/api/logs', logsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));
// Exposé pour que le bandeau du dashboard affiche honnêtement si les publications sont
// mockées ou réellement envoyées à Hubiflow — jamais silencieux.
app.get('/api/hubiflow-mode', (req, res) => res.json({ mode: hubiflowMode }));

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
    console.log(`[dashboard-server] démarré sur http://localhost:${PORT}`);
});

// Scheduler simple : vérifie chaque minute quelles recherches ont une fréquence programmée
// et sont dues (jamais exécutées, ou dernier run plus vieux que leur fréquence).
setInterval(async () => {
    const dues = db
        .prepare(
            `SELECT * FROM recherches
             WHERE frequence_minutes IS NOT NULL
             AND (
               derniere_execution_le IS NULL
               OR (strftime('%s', 'now') - strftime('%s', derniere_execution_le)) >= frequence_minutes * 60
             )`
        )
        .all();

    for (const recherche of dues) {
        try {
            // Recherches créées via otaree-search (URL reconnaissable) : vrai rescrape Otaree,
            // import seul, jamais d'auto-publish en arrière-plan (voir rescraperRechercheFavorite).
            // Anciennes recherches (URL pré-Otaree) : ancien moteur mock, comportement inchangé.
            await rescraperRechercheFavorite(recherche);
        } catch (e) {
            console.error('[dashboard-server] échec du scraping programmé:', e.message);
        }
    }
}, 60 * 1000);
