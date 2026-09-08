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
import { verifierDoublonsHubiflow } from '../services/doublonsChecker.js';
import {
    demarrerRecherche,
    mettreAJourProgression,
    terminerRecherche,
    echouerRecherche,
    getEtatRecherche,
} from '../services/rechercheStatus.js';
import { executerAvecUtilisateur, utilisateurActuelId } from '../services/requestContext.js';
import { sauvegarderRefreshToken, getOtareeTokenState } from '../integrations/otareeTokenStore.js';
import {
    rechercherLotsOtaree,
    rechercherLocationsOtaree,
    construireUrlRechercheOtaree,
    compterLotsOtaree,
    diagVerifierLot,
} from '../integrations/otareeSearchClient.js';

export const scraperRouter = Router();

// TEMPORAIRE — exploration faisabilité "signalement lot disparu d'Otaree" (2026-09-08). Lecture
// seule côté Otaree (aucune écriture en base). Lance une petite recherche réelle (sans importer),
// renvoie les champs de statut bruts des 3 premiers lots, plus un test de vérification directe
// (GET détail) sur le premier lot réel ET sur un atId fabriqué pour observer le comportement en
// cas de lot inexistant. À retirer une fois l'exploration terminée.
scraperRouter.post('/diag-verif-disparition', exigerConnexion, async (req, res) => {
    try {
        const { filters } = req.body || {};
        const { lots } = await rechercherLotsOtaree(filters || { where: [{ key: 'city_29781', label: 'Rouen', value: 'city_29781' }] });

        const statusCounts = {};
        for (const l of lots) {
            const key = `status=${l.status},feed=${l.feedStatus}`;
            statusCounts[key] = (statusCounts[key] || 0) + 1;
        }

        const parStatus = {};
        for (const l of lots) {
            const key = `${l.status}_${l.feedStatus}`;
            if (!parStatus[key]) parStatus[key] = l;
        }

        const verifsParStatus = {};
        for (const [key, l] of Object.entries(parStatus)) {
            const t0 = Date.now();
            const r = await diagVerifierLot(l['@id']);
            verifsParStatus[key] = {
                atId: l['@id'], statusRecherche: l.status, feedStatusRecherche: l.feedStatus,
                dureeMs: Date.now() - t0, httpStatus: r.httpStatus, ok: r.ok,
                extraitBody: r.ok ? { id: r.body?.id, status: r.body?.status, internalStatus: r.body?.internalStatus, feedStatus: r.body?.feedStatus, published: r.body?.published } : r.body,
            };
        }

        // Path correct observé (/properties/{id}, pas /estate/properties/{id}) mais id fabriqué —
        // pour voir la vraie signature d'un lot inexistant, distincte d'un simple 404 de routage.
        const atIdFabrique = `/properties/${lots[0]?.id || 'x'}fabrique000`;
        const t1 = Date.now();
        const verifLotInexistant = await diagVerifierLot(atIdFabrique);

        res.json({
            nbLotsTrouves: lots.length,
            repartitionStatus: statusCounts,
            verifsParStatus,
            verifLotInexistant: { atId: atIdFabrique, dureeMs: Date.now() - t1, httpStatus: verifLotInexistant.httpStatus, ok: verifLotInexistant.ok, body: verifLotInexistant.body },
        });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

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

// Asynchrone depuis l'incident du 502 sur un gros volume (~200 lots à Toulouse) : la pagination
// Otaree + l'import séquentiel en base peuvent dépasser la limite de 120s du proxy externe Vercel
// (dashboard/vercel.json), qui renvoie alors une erreur au navigateur alors que Render continue
// de traiter normalement — voir rechercheStatus.js. La route répond donc immédiatement avec
// enCours:true, le traitement réel continue après coup ; le dashboard suit/retrouve la
// progression par polling sur GET /otaree-search-status, même principe que l'auto-publication
// (voir autoPublishStatus.js) — y compris après un rafraîchissement de page, l'état vit côté
// serveur, pas dans le state React.
scraperRouter.post('/otaree-search', exigerConnexion, async (req, res) => {
    const { filters, nom, resume } = req.body || {};
    if (!filters || typeof filters !== 'object') {
        return res.status(400).json({ erreur: 'filters requis' });
    }
    if (getEtatRecherche().enCours) {
        return res.status(409).json({ erreur: 'Une recherche est déjà en cours — attends sa fin avant d\'en lancer une autre.' });
    }

    demarrerRecherche(nom?.trim() || null);
    res.json({ enCours: true });

    // Utilisateur courant capturé avant le retour de la requête HTTP (le contexte de requête
    // d'origine, voir requestContext.js, ne survit pas au-delà — le traitement continue dans une
    // tâche détachée) pour que log()/logs_api gardent la bonne attribution malgré l'exécution en
    // arrière-plan.
    const utilisateurId = utilisateurActuelId();
    executerAvecUtilisateur(utilisateurId, async () => {
        try {
            const { lots, tronque } = await rechercherLotsOtaree(filters);
            mettreAJourProgression(lots.length, 0);
            const url = construireUrlRechercheOtaree(filters);
            const { annonces, ...result } = await importerLotsOtaree(
                url, lots, nom?.trim() || null, resume?.trim() || null,
                (fait, total) => mettreAJourProgression(total, fait)
            );
            const autoPublish = await autoGenererEtPublier(annonces, result.rechercheId);
            terminerRecherche({ ...result, tronque, autoPublish });
        } catch (e) {
            echouerRecherche(e.message);
        }
    });
});

scraperRouter.get('/otaree-search-status', exigerConnexion, (req, res) => {
    res.json(getEtatRecherche());
});

scraperRouter.post('/auto-publish-confirm', exigerConnexion, async (req, res) => {
    try {
        const { idsSelectionnes, portailsChoisis, referencesEditees, imagesEditees } = req.body || {};
        const result = await confirmerRunEnAttente(
            Array.isArray(idsSelectionnes) ? idsSelectionnes : null,
            Array.isArray(portailsChoisis) ? portailsChoisis : null,
            referencesEditees && typeof referencesEditees === 'object' ? referencesEditees : null,
            imagesEditees && typeof imagesEditees === 'object' ? imagesEditees : null
        );
        if (!result.success) {
            return res.status(400).json({ erreur: result.error });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Bouton explicite "Vérifier les doublons" sur l'écran de confirmation — jamais automatique
// (voir doublonsChecker.js : évite de déclencher 2 appels Hubiflow par lot sur un run de 40-80+
// lots sans action volontaire de l'utilisateur).
scraperRouter.post('/verifier-doublons', exigerConnexion, async (req, res) => {
    try {
        const { ids, portailsChoisis } = req.body || {};
        const result = await verifierDoublonsHubiflow(
            Array.isArray(ids) ? ids : [],
            Array.isArray(portailsChoisis) ? portailsChoisis : []
        );
        if (result.erreur) {
            return res.status(400).json({ erreur: result.erreur });
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
