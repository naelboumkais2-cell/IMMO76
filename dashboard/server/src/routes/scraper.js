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
    upsertRecherche,
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
    construireUrlRechercheNationale,
    compterLotsOtaree,
    rechercherZoneAvecRepli,
    enrichirLot,
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

// Empreinte stable des filtres non géographiques — sert à décider si une progression
// enregistrée correspond bien à LA MÊME recherche nationale qu'on relance (des filtres
// différents = un run différent, on ne doit jamais reprendre le progrès de l'un pour l'autre).
function empreinteFiltres(filtresBase) {
    return JSON.stringify(filtresBase || {});
}

// Recherche "France entière" (pas de ville) : découpe en régions (repli département par
// département si une région dépasse le plafond de pagination MAX_PAGES, voir
// rechercherZoneAvecRepli/zonesFrance.js) plutôt qu'un seul appel Otaree avec `where` vide —
// une recherche nationale directe dépasse largement ce plafond et tourne assez longtemps pour
// risquer une expiration de jeton en route (voir le rafraîchissement mid-pagination dans
// otareeSearchClient.js). Même infrastructure de suivi asynchrone que /otaree-search (un seul
// run à la fois, partagé — voir rechercheStatus.js) : chaque région est importée en base dès
// qu'elle est prête, pas seulement à la toute fin, pour ne pas perdre le travail déjà fait si
// une région ultérieure échoue.
//
// Reprise (voir migration `progression_nationale`, db.js) : un run complet peut prendre
// plusieurs heures (~5h constaté en conditions réelles) — assez longtemps pour être interrompu
// par à peu près n'importe quoi (jeton Otaree expiré, crash mémoire, redéploiement Render...).
// Si une progression compatible (mêmes filtres) existe déjà pour cette recherche, les régions
// déjà terminées sont sautées et les compteurs repartent du cumul précédent, plutôt que de
// re-parcourir des heures de régions déjà importées à chaque relance.
scraperRouter.post('/otaree-search-national', exigerConnexion, async (req, res) => {
    const { filtresBase, nom, resume } = req.body || {};
    if (getEtatRecherche().enCours) {
        return res.status(409).json({ erreur: 'Une recherche est déjà en cours — attends sa fin avant d\'en lancer une autre.' });
    }

    const url = construireUrlRechercheNationale();
    const rechercheExistante = await upsertRecherche(url, nom?.trim() || 'France entière', resume?.trim() || null);
    const empreinte = empreinteFiltres(filtresBase);
    let progression = null;
    try {
        progression = rechercheExistante.progression_nationale ? JSON.parse(rechercheExistante.progression_nationale) : null;
    } catch {
        progression = null;
    }
    const reprise = !!(progression && progression.filtresFingerprint === empreinte && progression.regionsTerminees?.length);
    const regionsDejaTerminees = new Set(reprise ? progression.regionsTerminees : []);

    demarrerRecherche(nom?.trim() || 'France entière');
    res.json({ enCours: true, reprise, regionsDejaTerminees: [...regionsDejaTerminees] });

    const utilisateurId = utilisateurActuelId();
    executerAvecUtilisateur(utilisateurId, async () => {
        try {
            let totalTrouves = reprise ? progression.totalTrouves || 0 : 0;
            let totalImportes = reprise ? progression.totalImportes || 0 : 0;
            let nbNouvellesTotal = reprise ? progression.nbNouvellesTotal || 0 : 0;
            const rechercheId = rechercheExistante.id;
            const regionsTerminees = [...regionsDejaTerminees];
            mettreAJourProgression(totalTrouves, totalImportes);

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
            // Limite connue (inchangée par la reprise) : ce pré-filtre par `estNouvelle`
            // correspond au critère du mode AUTO_PUBLISH par défaut ('on') — voir
            // autoGenererEtPublier, orchestrator.js. En mode 'test' (critère réel :
            // est_annonce_test), une annonce déjà connue mais marquée test serait exclue ici
            // alors qu'autoGenererEtPublier l'aurait normalement retenue.
            //
            // Limite connue de la reprise elle-même : candidatsAccumules ne contient que les
            // nouvelles annonces des régions traitées PENDANT CETTE tentative — celles des
            // régions déjà terminées lors d'une tentative précédente (interrompue) sont bien
            // importées en base (jamais perdues), mais ne sont pas reconsidérées ici pour
            // l'auto-publication de ce run repris (republish manuel possible depuis
            // Supervision si besoin, même filet de sécurité que le dépassement de MAX_PAR_RUN).
            let candidatsAccumules = [];

            for (const region of REGIONS_FRANCE) {
                if (regionsDejaTerminees.has(region.nom)) continue;

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
                    if (candidatsAccumules.length < MAX_PAR_RUN) {
                        const nouvelles = result.annonces.filter((a) => a.estNouvelle);
                        candidatsAccumules = candidatsAccumules.concat(nouvelles.slice(0, MAX_PAR_RUN - candidatsAccumules.length));
                    }
                    mettreAJourProgression(totalTrouves, totalImportes);
                });

                // Persisté après CHAQUE région (pas seulement à la fin) : c'est le point de
                // reprise réel en cas d'interruption — région par région, jamais au milieu d'une.
                regionsTerminees.push(region.nom);
                await db.prepare(`UPDATE recherches SET progression_nationale = ? WHERE id = ?`).run(
                    JSON.stringify({ filtresFingerprint: empreinte, regionsTerminees, totalTrouves, totalImportes, nbNouvellesTotal }),
                    rechercheId
                );
            }

            // Toutes les régions traitées avec succès : plus rien à reprendre, et
            // dernieres_annonces_trouvees reflète enfin le vrai total (importerLotsOtaree
            // l'écrase à chaque appel avec le compte de la SEULE région qu'il vient de traiter).
            await db.prepare(`UPDATE recherches SET dernieres_annonces_trouvees = ?, progression_nationale = NULL WHERE id = ?`)
                .run(totalTrouves, rechercheId);

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

// TEMPORAIRE — renvoie le JSON brut COMPLET d'un vrai lot (détail + programme fusionnés, comme
// enrichirLot le fait avant génération) pour inventorier quels champs Hubiflow ont déjà un
// équivalent Otaree inexploité. Aucun mapping, juste un dump brut à inspecter.
scraperRouter.post('/diag-lot-brut', exigerConnexion, async (req, res) => {
    try {
        const { villeCode, villeLabel } = req.body || {};
        const where = [{ label: villeLabel || 'Rouen', key: villeCode || 'city_29781', value: villeCode || 'city_29781' }];
        const { lots } = await rechercherLotsOtaree({ where });
        if (!lots.length) return res.status(404).json({ erreur: 'Aucun lot trouvé pour cette ville' });

        const lotEnrichi = await enrichirLot(structuredClone(lots[0]));
        res.json(lotEnrichi);
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
