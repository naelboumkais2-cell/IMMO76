import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { db, initDb } from './db.js';
import { scraperRouter } from './routes/scraper.js';
import { portailsRouter } from './routes/portails.js';
import { annoncesRouter } from './routes/annonces.js';
import { logsRouter } from './routes/logs.js';
import { authRouter } from './routes/auth.js';
import { exigerConnexion, exigerCleMachine } from './middleware/auth.js';
import { rescraperRechercheFavorite } from './services/orchestrator.js';
import { mode as hubiflowMode } from './integrations/hubiflowRouter.js';
import { verifierEtMettreAJourDepenses } from './services/depenseMonitor.js';
import { depensesRouter } from './routes/depenses.js';

// Filet de sécurité pour le diagnostic en hébergement distant : sans ça, un rejet de promesse
// non intercepté peut faire quitter le process sans qu'aucun message n'apparaisse dans les logs
// de la plateforme (vu sur Render — "Application exited early" sans trace).
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// Init Postgres database
initDb().catch((err) => console.error('[initDb] échec :', err));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/scraper', scraperRouter);
app.use('/api/portails', portailsRouter);
app.use('/api/annonces', annoncesRouter);
app.use('/api/logs', logsRouter);
app.use('/api/depenses', depensesRouter);

// Non protégé volontairement : nécessaire aux vérifications de santé de la plateforme
// d'hébergement (Render), qui n'a évidemment pas de session — ne révèle aucune donnée.
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/hubiflow-mode', exigerConnexion, (req, res) => res.json({ mode: hubiflowMode }));

// Recherches à fréquence programmée dues — factorisé pour être appelable à la fois depuis
// /api/cron (si un jour un vrai cron externe est branché dessus) et depuis le setInterval
// ci-dessous (le déclencheur réellement actif aujourd'hui, voir commentaire plus bas). Passe par
// rescraperRechercheFavorite -> importerLotsOtaree, qui n'appelle jamais autoGenererEtPublier :
// le rescraping programmé importe uniquement, ne publie jamais rien tout seul (décision de
// sécurité explicite, voir orchestrator.js).
async function executerRecherchesDues() {
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
    return nbExecuted;
}

// Route machine (aucun humain connecté), voir middleware/auth.js — conservée au cas où un vrai
// cron externe serait un jour configuré, mais rien ne l'appelle actuellement (voir setInterval
// ci-dessous, seul déclencheur réel aujourd'hui : aucune section "crons" dans dashboard/vercel.json
// et aucun setInterval ne subsistait après le remplacement historique de ce mécanisme — les
// recherches à fréquence programmée ne se relançaient donc plus jamais automatiquement).
app.get('/api/cron', exigerCleMachine, async (req, res) => {
    try {
        const count = await executerRecherchesDues();
        res.json({ success: true, count });
    } catch (e) {
        console.error('[cron] erreur globale:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Déclencheur réel du rescraping programmé — voir commentaire au-dessus de executerRecherchesDues.
// 1 min : la fréquence configurable la plus fine étant 15 min (voir FREQUENCE_OPTIONS côté
// client), une vérification par minute suffit largement à rester réactif sans solliciter la base
// inutilement. Ne tourne que sur un process persistant (jamais utile sur Vercel serverless).
if (!process.env.VERCEL) {
    const verifierRecherchesDues = () => executerRecherchesDues().catch((e) => console.error('[scheduler] échec:', e.message));
    verifierRecherchesDues();
    setInterval(verifierRecherchesDues, 60 * 1000);
}

// Plafond de dépense (voir services/depenseMonitor.js) : contrôle toutes les 10 min — plus
// fréquent n'aurait aucun intérêt, les chiffres de consommation Neon eux-mêmes ne remontent que
// toutes les ~15 min. Ne tourne que sur un process persistant (jamais utile sur Vercel
// serverless, voir le garde plus bas), démarré immédiatement puis répété.
if (!process.env.VERCEL) {
    const controleDepenses = () => verifierEtMettreAJourDepenses().catch((e) => console.error('[depenseMonitor] échec du contrôle:', e.message));
    controleDepenses();
    setInterval(controleDepenses, 10 * 60 * 1000);
}

// Sur Vercel, `VERCEL` est toujours défini (peu importe NODE_ENV) — écouter un port n'a aucun
// sens là-bas (fonction serverless, pas de process persistant). Partout ailleurs (local, Render,
// tout hébergeur classique), on démarre un vrai serveur qui tourne en continu.
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 4100;
    // '0.0.0.0' explicite : sur certains hébergeurs (Render...), écouter sans préciser
    // l'interface ne se lie qu'en local/IPv6-loopback selon la version de Node — invisible
    // depuis l'extérieur du conteneur, donc le port ne semble jamais "ouvert" pour la
    // plateforme, qui tue alors le process sans qu'aucune erreur applicative ne s'affiche.
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[dashboard-server] démarré sur http://localhost:${PORT}`);
    });
}

// For Vercel serverless functions
export default app;
