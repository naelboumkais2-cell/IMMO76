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
import { sauvegarderRefreshToken, getOtareeTokenState, getOtareeCredentials } from '../integrations/otareeTokenStore.js';
import {
    rechercherLotsOtaree,
    rechercherLocationsOtaree,
    construireUrlRechercheOtaree,
    construireUrlRechercheNationale,
    compterLotsOtaree,
    rechercherZoneAvecRepli,
} from '../integrations/otareeSearchClient.js';
import { REGIONS_FRANCE } from '../integrations/zonesFrance.js';
import { MAX_PAR_RUN } from '../integrations/autoPublishConfig.js';

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

// Recherche "France entière" (pas de ville) : découpe en régions (repli département par
// département si une région dépasse le plafond de pagination MAX_PAGES, voir
// rechercherZoneAvecRepli/zonesFrance.js) plutôt qu'un seul appel Otaree avec `where` vide —
// une recherche nationale directe dépasse largement ce plafond et tourne assez longtemps pour
// risquer une expiration de jeton en route (voir le rafraîchissement mid-pagination dans
// otareeSearchClient.js). Même infrastructure de suivi asynchrone que /otaree-search (un seul
// run à la fois, partagé — voir rechercheStatus.js) : chaque région est importée en base dès
// qu'elle est prête, pas seulement à la toute fin, pour ne pas perdre le travail déjà fait si
// une région ultérieure échoue.
scraperRouter.post('/otaree-search-national', exigerConnexion, async (req, res) => {
    const { filtresBase, nom, resume } = req.body || {};
    if (getEtatRecherche().enCours) {
        return res.status(409).json({ erreur: 'Une recherche est déjà en cours — attends sa fin avant d\'en lancer une autre.' });
    }

    demarrerRecherche(nom?.trim() || 'France entière');
    res.json({ enCours: true });

    const utilisateurId = utilisateurActuelId();
    executerAvecUtilisateur(utilisateurId, async () => {
        try {
            const url = construireUrlRechercheNationale();
            let totalTrouves = 0;
            let totalImportes = 0;
            let nbNouvellesTotal = 0;
            let rechercheId = null;
            // Ne garde en mémoire que les nouvelles annonces, plafonnées à MAX_PAR_RUN (400) —
            // au-delà, executerTraitement (orchestrator.js) les ignorerait de toute façon
            // (`candidats.slice(0, MAX_PAR_RUN)`), donc les retenir toutes ne servirait à rien.
            // Avant ce plafond, accumuler le JSON brut de chaque lot pour la France entière avant
            // le seul appel à autoGenererEtPublier en fin de boucle a fait planter le process en
            // "JavaScript heap out of memory" (constaté en conditions réelles, run réel du
            // 2026-09-09 — voir FATAL ERROR / Aborted dans les logs Render). Tous les lots
            // continuent d'être importés en base normalement (import ci-dessous, indépendant de
            // ce plafond) ; seul ce qui reste en mémoire JS pour la décision d'auto-publication
            // est borné.
            //
            // Limite connue : ce pré-filtre par `estNouvelle` correspond au critère du mode
            // AUTO_PUBLISH par défaut ('on') — voir autoGenererEtPublier, orchestrator.js. En
            // mode 'test' (critère réel : est_annonce_test), une annonce déjà connue mais
            // marquée test serait exclue ici alors qu'autoGenererEtPublier l'aurait normalement
            // retenue. Sans impact pratique tant qu'AUTO_PUBLISH reste 'on' en production ; à
            // généraliser si le mode 'test' doit un jour servir sur une recherche nationale.
            let candidatsAccumules = [];

            for (const region of REGIONS_FRANCE) {
                // Import à l'intérieur même du callback (voir rechercherZoneAvecRepli) : chaque
                // sous-zone (région entière, ou un seul département en cas de repli) est importée
                // et peut partir au ramasse-miettes avant que la suivante ne soit demandée à
                // Otaree — jamais plus d'une seule sous-zone (~3000 lots max) en mémoire à la fois.
                await rechercherZoneAvecRepli(region.nom, region.departements, filtresBase || {}, async (lots) => {
                    totalTrouves += lots.length;
                    mettreAJourProgression(totalTrouves, totalImportes);

                    const result = await importerLotsOtaree(
                        url, lots, nom?.trim() || 'France entière', resume?.trim() || null,
                        (fait) => mettreAJourProgression(totalTrouves, totalImportes + fait)
                    );
                    totalImportes += lots.length;
                    nbNouvellesTotal += result.nbNouvelles;
                    rechercheId = result.rechercheId;
                    if (candidatsAccumules.length < MAX_PAR_RUN) {
                        const nouvelles = result.annonces.filter((a) => a.estNouvelle);
                        candidatsAccumules = candidatsAccumules.concat(nouvelles.slice(0, MAX_PAR_RUN - candidatsAccumules.length));
                    }
                    mettreAJourProgression(totalTrouves, totalImportes);
                });
            }

            // importerLotsOtaree écrase `dernieres_annonces_trouvees` à chaque appel avec le
            // compte de la SEULE région qu'il vient de traiter — corrigé ici une fois, avec le
            // vrai total, pour que la fiche recherche affiche un nombre cohérent.
            if (rechercheId) {
                await db.prepare(`UPDATE recherches SET dernieres_annonces_trouvees = ? WHERE id = ?`).run(totalTrouves, rechercheId);
            }

            const autoPublish = await autoGenererEtPublier(candidatsAccumules, rechercheId);
            terminerRecherche({ rechercheId, nbLots: totalTrouves, nbNouvelles: nbNouvellesTotal, tronque: false, autoPublish });
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

// TEMPORAIRE — inspecte le corps COMPLET de la réponse /security/refresh-token (pas juste
// data.token comme refreshJwt) pour comprendre pourquoi le run France entière a fini par
// échouer avec "Session Otaree expirée" après ~5h et ~22 rafraîchissements — hypothèse à
// vérifier : rotation du refresh_token (un nouveau émis à chaque appel, l'ancien invalidé),
// qu'on jetterait silencieusement aujourd'hui puisque seul data.token est lu.
scraperRouter.post('/diag-refresh-body', exigerConnexion, async (req, res) => {
    try {
        const credentials = await getOtareeCredentials();
        if (!credentials) return res.status(400).json({ erreur: 'Aucun accès Otaree connu' });

        const resAvant = await getOtareeTokenState();
        const r = await fetch('https://api.link-app.immo/security/refresh-token', {
            method: 'POST',
            headers: {
                Origin: 'https://plusimmo76.link-app.immo',
                Referer: 'https://plusimmo76.link-app.immo/',
                'Content-Type': 'application/json',
                ...(credentials.device ? { 'X-Device': credentials.device } : {}),
                ...(credentials.instanceId ? { 'X-Instance-Id': credentials.instanceId } : {}),
            },
            body: JSON.stringify({ device: credentials.device, refresh_token: credentials.refreshToken }),
        });
        const headers = Object.fromEntries(r.headers.entries());
        const body = await r.json().catch(() => null);
        res.json({ httpStatus: r.status, headers, body, etatTokenAvantAppel: resAvant });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — teste le repli région -> départements sur une grande région connue pour dépasser
// le plafond de pagination, avant de valider le mécanisme sur une vraie recherche France entière.
scraperRouter.post('/diag-zone', exigerConnexion, async (req, res) => {
    try {
        const { nomRegion } = req.body || {};
        const region = REGIONS_FRANCE.find((r) => r.nom === nomRegion);
        if (!region) return res.status(400).json({ erreur: `Région inconnue : ${nomRegion}` });

        const t0 = Date.now();
        let nb = 0;
        const { zones } = await rechercherZoneAvecRepli(region.nom, region.departements, {}, async (lots) => {
            nb += lots.length;
        });
        res.json({ nb, zones, dureeMs: Date.now() - t0 });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — teste un seul département isolément (timing réel), pour comprendre pourquoi le
// repli région -> départements complet (8 départements enchaînés en une seule requête HTTP) a
// échoué en 502 après ~14 min sur Île-de-France.
scraperRouter.post('/diag-dept', exigerConnexion, async (req, res) => {
    try {
        const { nomDept } = req.body || {};
        const locs = await rechercherLocationsOtaree(nomDept);
        const dept = locs.find((l) => l.type === 'department' && l.name.toLowerCase() === nomDept.toLowerCase());
        if (!dept) return res.status(400).json({ erreur: `Département introuvable : ${nomDept}` });

        const t0 = Date.now();
        const { lots, tronque } = await rechercherLotsOtaree({ where: [{ label: dept.name, key: dept.code, value: dept.code }] });
        res.json({ nom: dept.name, nb: lots.length, tronque, dureeMs: Date.now() - t0 });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
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
