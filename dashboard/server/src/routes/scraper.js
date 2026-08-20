import { Router } from 'express';
import { db } from '../db.js';
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

// Liste des recherches connues, la plus récemment exécutée en premier.
scraperRouter.get('/recherches', (req, res) => {
    const recherches = db
        .prepare(
            `SELECT r.*, COUNT(sr.id) AS nb_runs
             FROM recherches r
             LEFT JOIN scraper_runs sr ON sr.recherche_id = r.id
             GROUP BY r.id
             ORDER BY (r.derniere_execution_le IS NULL), r.derniere_execution_le DESC, r.cree_le DESC`
        )
        .all();
    res.json(recherches);
});

// Historique des runs d'une recherche précise (même URL rescrapée plusieurs fois).
scraperRouter.get('/recherches/:id/runs', (req, res) => {
    const runs = db
        .prepare(`SELECT * FROM scraper_runs WHERE recherche_id = ? ORDER BY execute_le DESC`)
        .all(req.params.id);
    res.json(runs);
});

// Fréquence de rescraping programmé, rattachée à cette recherche précise (null = manuel uniquement).
scraperRouter.put('/recherches/:id/frequence', (req, res) => {
    const { minutes } = req.body;
    db.prepare(`UPDATE recherches SET frequence_minutes = ? WHERE id = ?`).run(minutes ?? null, req.params.id);
    res.json(db.prepare(`SELECT * FROM recherches WHERE id = ?`).get(req.params.id));
});

// Marque/démarque une recherche comme favorite (alertes de nouveaux lots) — indépendant de
// frequence_minutes, voir /alertes pour le signalement explicite si aucune fréquence n'est
// programmée.
scraperRouter.put('/recherches/:id/favori', (req, res) => {
    const { favori } = req.body;
    db.prepare(`UPDATE recherches SET favori = ? WHERE id = ?`).run(favori ? 1 : 0, req.params.id);
    res.json(db.prepare(`SELECT * FROM recherches WHERE id = ?`).get(req.params.id));
});

// Recherches favorites avec, pour chacune, le nombre de nouveaux lots trouvés depuis la
// dernière consultation de ce panneau (pas depuis le dernier run) — annonces.scrapee_le ne
// bouge jamais pour un lot déjà connu (INSERT OR IGNORE), donc cette comparaison reste fiable
// même après plusieurs rescrapes.
scraperRouter.get('/alertes', (req, res) => {
    const favorites = db
        .prepare(
            `SELECT r.*,
                    (SELECT COUNT(*) FROM annonces a
                     WHERE a.recherche_id = r.id
                     AND a.scrapee_le > COALESCE(r.derniere_consultation_alertes_le, '1970-01-01')
                    ) AS nouveaux_lots
             FROM recherches r
             WHERE r.favori = 1
             ORDER BY nouveaux_lots DESC, (r.derniere_execution_le IS NULL), r.derniere_execution_le DESC`
        )
        .all();
    res.json(favorites);
});

// À appeler à l'ouverture du panneau notifications — marque toutes les favorites comme
// consultées maintenant (les nouveaux lots déjà comptés ne remonteront plus jusqu'au prochain
// nouveau lot réellement trouvé).
scraperRouter.post('/alertes/consultees', (req, res) => {
    db.prepare(`UPDATE recherches SET derniere_consultation_alertes_le = datetime('now') WHERE favori = 1`).run();
    res.json({ success: true });
});

// Déclenche un run : `url` fournie -> rescrape la recherche existante ; omise -> nouvelle
// recherche (dans le mock, une URL factice est générée pour simuler l'extension).
scraperRouter.post('/run', async (req, res) => {
    try {
        const { url } = req.body || {};
        const result = await lancerScrapingEtDiffusion(url || undefined);
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Reçoit une copie des vrais lots scrapés par l'extension Otaree (en plus de l'écriture dans
// Downloads, pas à la place) — coexistence avec le pipeline existant, supervision uniquement
// pour l'instant (aucune publication déclenchée depuis ce endpoint). Best-effort côté
// extension : si le dashboard ne tourne pas, l'appel échoue silencieusement sans impact sur
// Downloads ni sur le Watcher de Ubiflow-Auto-API/server.js.
scraperRouter.post('/otaree-import', (req, res) => {
    try {
        const { url, lots } = req.body || {};
        if (!url) return res.status(400).json({ erreur: 'url requise' });
        if (!Array.isArray(lots)) return res.status(400).json({ erreur: 'lots doit être un tableau' });

        const result = importerLotsOtaree(url, lots);
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Reçoit le refresh_token Otaree capturé par extension-chrome/Otaree/ (mécanisme indépendant
// du token Hubiflow — voir otareeTokenStore.js). Best-effort côté extension : si le dashboard
// ne tourne pas, échoue silencieusement.
scraperRouter.post('/otaree-token', (req, res) => {
    const { refreshToken, device, instanceId } = req.body || {};
    if (!refreshToken) return res.status(400).json({ erreur: 'refreshToken requis' });

    sauvegarderRefreshToken(refreshToken, device || null, instanceId || null);
    console.log(`[otaree-token] refresh_token capturé (device: ${device || 'inconnu'})`);
    res.json({ success: true });
});

// État du refresh_token stocké — jamais sa valeur, juste sa présence/date, pour vérification.
scraperRouter.get('/otaree-token', (req, res) => {
    res.json(getOtareeTokenState());
});

// Recherche Otaree directe, server-side, sans navigateur — utilise le refresh_token stocké.
// Mêmes filtres bruts qu'Otaree lui-même (ex: { where: [...], maxPrice: "70000" }), passés
// tels quels. Résultats importés comme /otaree-import (routage vers les portails, Supervision),
// puis éventuellement auto-générés/publiés selon AUTO_PUBLISH (off par défaut — voir
// autoPublishConfig.js et orchestrator.autoGenererEtPublier).
// Comptage rapide avant de lancer une vraie recherche — lecture seule, une seule page, ne
// touche jamais importerLotsOtaree/AUTO_PUBLISH.
scraperRouter.post('/otaree-count', async (req, res) => {
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

scraperRouter.post('/otaree-search', async (req, res) => {
    try {
        const { filters, nom, resume, confirmationRequise } = req.body || {};
        if (!filters || typeof filters !== 'object') {
            return res.status(400).json({ erreur: 'filters requis' });
        }

        const { lots, tronque } = await rechercherLotsOtaree(filters);
        const url = construireUrlRechercheOtaree(filters);
        const { annonces, ...result } = importerLotsOtaree(url, lots, nom?.trim() || null, resume?.trim() || null);
        const autoPublish = await autoGenererEtPublier(annonces, result.rechercheId, { confirmationRequise: !!confirmationRequise });
        res.json({ ...result, tronque, autoPublish });
    } catch (e) {
        if (e.code === 'NO_CREDENTIALS' || e.code === 'REFRESH_FAILED') {
            return res.status(401).json({ erreur: e.message });
        }
        res.status(500).json({ erreur: e.message });
    }
});

// Déclenche un run mis en attente par la confirmation obligatoire du mode 'on' (écran de choix
// lots/portails/mode) — rien n'a été envoyé à Hubiflow avant cet appel explicite.
scraperRouter.post('/auto-publish-confirm', async (req, res) => {
    const { idsSelectionnes, portailsChoisis } = req.body || {};
    const result = await confirmerRunEnAttente(
        Array.isArray(idsSelectionnes) ? idsSelectionnes : null,
        Array.isArray(portailsChoisis) ? portailsChoisis : null
    );
    if (!result.success) {
        return res.status(400).json({ erreur: result.error });
    }
    res.json(result);
});

// Abandonne un run en attente — les lots restent importés/routés, jamais traités.
scraperRouter.post('/auto-publish-discard-pending', (req, res) => {
    const result = annulerRunEnAttente();
    if (!result.success) {
        return res.status(400).json({ erreur: result.error });
    }
    res.json(result);
});

// Détail enrichi d'un lot précis du run en attente — pour la carte cliquée sur l'écran de
// confirmation. N'inclut jamais de titre/description/DPE générés par IA (voir orchestrator.js).
scraperRouter.post('/lot-detail', async (req, res) => {
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

// État du run auto-publish en cours (si AUTO_PUBLISH != off) — à interroger par polling
// pendant qu'une recherche tourne, un run pouvant prendre ~25-30 min pour 50 lots.
scraperRouter.get('/auto-publish-status', (req, res) => {
    res.json(getEtatAutoPublish());
});

// Demande d'arrêt du run en cours — la boucle séquentielle s'arrête avant le lot suivant, jamais
// en plein milieu d'un lot déjà commencé. Un seul run possible à la fois, pas de paramètre requis.
scraperRouter.post('/auto-publish-cancel', (req, res) => {
    demanderAnnulation();
    res.json({ success: true });
});

// Autocomplétion de ville, pour le champ de recherche du dashboard — relais direct de
// locations.json. Renvoie [] sans appel réseau si q fait moins de 2 caractères.
scraperRouter.get('/otaree-locations', async (req, res) => {
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
