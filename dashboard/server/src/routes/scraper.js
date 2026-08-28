import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion, exigerCleMachine } from '../middleware/auth.js';
import {
    lancerScrapingEtDiffusion,
    importerLotsOtaree,
    autoGenererEtPublier,
    confirmerRunEnAttente,
    annulerRunEnAttente,
    detailLotEnAttente,
} from '../services/orchestrator.js';
import { getEtatAutoPublish, demanderAnnulation } from '../services/autoPublishStatus.js';
import { sauvegarderRefreshToken, getOtareeTokenState } from '../integrations/otareeTokenStore.js';
import {
    rechercherLotsOtaree,
    rechercherLocationsOtaree,
    construireUrlRechercheOtaree,
    compterLotsOtaree,
} from '../integrations/otareeSearchClient.js';

export const scraperRouter = Router();

scraperRouter.get('/recherches', exigerConnexion, async (req, res) => {
    try {
        const recherches = await db
            .prepare(
                `SELECT r.*, COUNT(sr.id) AS nb_runs
                 FROM recherches r
                 LEFT JOIN scraper_runs sr ON sr.recherche_id = r.id
                 GROUP BY r.id
                 ORDER BY (r.derniere_execution_le IS NULL) DESC, r.derniere_execution_le DESC, r.cree_le DESC`
            )
            .all();
        res.json(recherches);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.get('/recherches/:id/runs', exigerConnexion, async (req, res) => {
    try {
        const runs = await db
            .prepare(`SELECT * FROM scraper_runs WHERE recherche_id = ? ORDER BY execute_le DESC`)
            .all(req.params.id);
        res.json(runs);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.put('/recherches/:id/frequence', exigerConnexion, async (req, res) => {
    try {
        const { minutes } = req.body;
        await db.prepare(`UPDATE recherches SET frequence_minutes = ? WHERE id = ?`).run(minutes ?? null, req.params.id);
        res.json(await db.prepare(`SELECT * FROM recherches WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.put('/recherches/:id/favori', exigerConnexion, async (req, res) => {
    try {
        const { favori } = req.body;
        await db.prepare(`UPDATE recherches SET favori = ? WHERE id = ?`).run(favori ? 1 : 0, req.params.id);
        res.json(await db.prepare(`SELECT * FROM recherches WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.get('/alertes', exigerConnexion, async (req, res) => {
    try {
        const favorites = await db
            .prepare(
                `SELECT r.*,
                        (SELECT COUNT(*) FROM annonces a
                         WHERE a.recherche_id = r.id
                         AND a.scrapee_le > COALESCE(r.derniere_consultation_alertes_le, '1970-01-01')
                        ) AS nouveaux_lots
                 FROM recherches r
                 WHERE r.favori = 1
                 ORDER BY nouveaux_lots DESC, (r.derniere_execution_le IS NULL) DESC, r.derniere_execution_le DESC`
            )
            .all();
        res.json(favorites);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/alertes/consultees', exigerConnexion, async (req, res) => {
    try {
        await db.prepare(`UPDATE recherches SET derniere_consultation_alertes_le = CURRENT_TIMESTAMP WHERE favori = 1`).run();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/run', exigerConnexion, async (req, res) => {
    try {
        const { url } = req.body || {};
        const result = await lancerScrapingEtDiffusion(url || undefined);
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Route machine : l'extension Chrome Otaree poste ici en arrière-plan, sans humain connecté au
// dashboard — protégée par clé partagée (exigerCleMachine), pas par une session (voir
// middleware/auth.js).
scraperRouter.post('/otaree-import', exigerCleMachine, async (req, res) => {
    try {
        const { url, lots } = req.body || {};
        if (!url) return res.status(400).json({ erreur: 'url requise' });
        if (!Array.isArray(lots)) return res.status(400).json({ erreur: 'lots doit être un tableau' });

        const result = await importerLotsOtaree(url, lots, null, null);
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Idem : capture automatique du refresh_token par l'extension, sans humain connecté.
scraperRouter.post('/otaree-token', exigerCleMachine, async (req, res) => {
    const { refreshToken, device, instanceId } = req.body || {};
    if (!refreshToken) return res.status(400).json({ erreur: 'refreshToken requis' });

    await sauvegarderRefreshToken(refreshToken, device || null, instanceId || null);
    console.log(`[otaree-token] refresh_token capturé (device: ${device || 'inconnu'})`);
    res.json({ success: true });
});

scraperRouter.get('/otaree-token', exigerConnexion, async (req, res) => {
    res.json(await getOtareeTokenState());
});

scraperRouter.post('/otaree-count', exigerConnexion, async (req, res) => {
    try {
        const { filters } = req.body || {};
        if (!filters || typeof filters !== 'object') {
            return res.status(400).json({ erreur: 'filters requis' });
        }
        const result = await compterLotsOtaree(filters);
        res.json(result);
    } catch (e) {
        if (e.code === 'NO_CREDENTIALS' || e.code === 'REFRESH_FAILED') {
            return res.status(401).json({ erreur: e.message });
        }
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/otaree-search', exigerConnexion, async (req, res) => {
    try {
        const { filters, nom, resume, confirmationRequise } = req.body || {};
        if (!filters || typeof filters !== 'object') {
            return res.status(400).json({ erreur: 'filters requis' });
        }

        const { lots, tronque } = await rechercherLotsOtaree(filters);
        const url = construireUrlRechercheOtaree(filters);
        const { annonces, ...result } = await importerLotsOtaree(url, lots, nom?.trim() || null, resume?.trim() || null);
        const autoPublish = await autoGenererEtPublier(annonces, result.rechercheId, { confirmationRequise: !!confirmationRequise });
        res.json({ ...result, tronque, autoPublish });
    } catch (e) {
        if (e.code === 'NO_CREDENTIALS' || e.code === 'REFRESH_FAILED') {
            return res.status(401).json({ erreur: e.message });
        }
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/auto-publish-confirm', exigerConnexion, async (req, res) => {
    try {
        const { idsSelectionnes, portailsChoisis, referencesEditees } = req.body || {};
        const result = await confirmerRunEnAttente(
            Array.isArray(idsSelectionnes) ? idsSelectionnes : null,
            Array.isArray(portailsChoisis) ? portailsChoisis : null,
            referencesEditees && typeof referencesEditees === 'object' ? referencesEditees : null
        );
        if (!result.success) {
            return res.status(400).json({ erreur: result.error });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/auto-publish-discard-pending', exigerConnexion, async (req, res) => {
    try {
        const result = await annulerRunEnAttente();
        if (!result.success) {
            return res.status(400).json({ erreur: result.error });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.post('/lot-detail', exigerConnexion, async (req, res) => {
    try {
        const { annonceId } = req.body || {};
        if (!annonceId) return res.status(400).json({ erreur: 'annonceId requis' });

        const result = await detailLotEnAttente(annonceId);
        if (!result.success) {
            return res.status(400).json({ erreur: result.error });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

scraperRouter.get('/auto-publish-status', exigerConnexion, (req, res) => {
    res.json(getEtatAutoPublish());
});

scraperRouter.post('/auto-publish-cancel', exigerConnexion, (req, res) => {
    demanderAnnulation();
    res.json({ success: true });
});

scraperRouter.get('/otaree-locations', exigerConnexion, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json([]);

        const locations = await rechercherLocationsOtaree(q);
        res.json(locations);
    } catch (e) {
        if (e.code === 'NO_CREDENTIALS' || e.code === 'REFRESH_FAILED') {
            return res.status(401).json({ erreur: e.message });
        }
        res.status(500).json({ erreur: e.message });
    }
});
