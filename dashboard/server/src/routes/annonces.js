import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';

export const annoncesRouter = Router();

// TEMPORAIRE — inventaire complet avant remise à zéro du dashboard (2026-09-07). Lecture seule,
// aucune écriture. Vue d'ensemble : recherches, annonces par recherche/ville, répartition des
// statuts de publication, comptes utilisateurs et règles de routage (à garder, listés pour
// confirmation seulement). Ne vérifie PAS l'état réel Hubiflow ici (trop coûteux en un seul appel
// pour un volume inconnu à l'avance) — voir /diag-etat-hubiflow séparément une fois le volume connu.
annoncesRouter.get('/diag-inventaire', exigerConnexion, async (req, res) => {
    try {
        const recherches = await db
            .prepare(
                `SELECT r.id, r.url, r.nom, r.resume, r.favori, r.cree_le, r.derniere_execution_le,
                        r.dernieres_annonces_trouvees, r.derniere_erreur,
                        (SELECT COUNT(*) FROM annonces a WHERE a.recherche_id = r.id) AS nb_annonces
                 FROM recherches r ORDER BY r.id`
            )
            .all();

        const annoncesParRechercheVille = await db
            .prepare(
                `SELECT recherche_id, ville, COUNT(*) AS nb, MIN(scrapee_le) AS premiere, MAX(scrapee_le) AS derniere,
                        SUM(CASE WHEN est_annonce_test = 1 THEN 1 ELSE 0 END) AS nb_marquees_test
                 FROM annonces GROUP BY recherche_id, ville ORDER BY recherche_id, ville`
            )
            .all();

        const totalAnnonces = await db.prepare(`SELECT COUNT(*) AS nb FROM annonces`).get();

        const statutsPortails = await db
            .prepare(
                `SELECT p.nom AS portail_nom, ap.statut, ap.mode, COUNT(*) AS nb,
                        SUM(CASE WHEN ap.ad_id_externe IS NOT NULL THEN 1 ELSE 0 END) AS nb_avec_ad_id_externe
                 FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
                 GROUP BY p.nom, ap.statut, ap.mode ORDER BY p.nom, ap.statut, ap.mode`
            )
            .all();

        const totalAvecAdIdExterne = await db
            .prepare(`SELECT COUNT(*) AS nb FROM annonce_portails WHERE ad_id_externe IS NOT NULL`)
            .get();

        const utilisateurs = await db
            .prepare(`SELECT id, email, nom, role, cree_le FROM utilisateurs ORDER BY id`)
            .all();

        const reglesRoutage = await db
            .prepare(
                `SELECT rr.id, rr.type_bien, rr.dispositif, p.nom AS portail_nom
                 FROM regles_routage rr JOIN portails p ON p.id = rr.portail_id
                 ORDER BY rr.id`
            )
            .all();

        const portails = await db.prepare(`SELECT id, nom, actif, mode_publication_defaut, login FROM portails ORDER BY id`).all();

        res.json({
            recherches,
            annoncesParRechercheVille,
            totalAnnonces: totalAnnonces.nb,
            statutsPortails,
            totalAvecAdIdExterne: totalAvecAdIdExterne.nb,
            utilisateurs,
            reglesRoutage,
            portails,
        });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — liste des (annonce_id, portail_id) déjà envoyés à Hubiflow au moins une fois, pour
// piloter la vérification de l'état réel via /portails/:portailId/synchroniser (déjà existant).
annoncesRouter.get('/diag-liste-ad-id-externe', exigerConnexion, async (req, res) => {
    try {
        const rows = await db
            .prepare(
                `SELECT ap.annonce_id, ap.portail_id, ap.ad_id_externe, ap.statut, a.titre, a.ville
                 FROM annonce_portails ap JOIN annonces a ON a.id = ap.annonce_id
                 WHERE ap.ad_id_externe IS NOT NULL ORDER BY ap.annonce_id`
            )
            .all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — remise à zéro (2026-09-07), étape 1/2 : comptes de test + portail de test. Liste
// d'emails et nom de portail explicites, en dur, validés un par un avec l'utilisateur avant
// exécution — aucune suppression par pattern générique pour ne jamais toucher un compte réel par
// erreur. sessions (CASCADE) et connexions_log/logs_api (SET NULL) gèrent déjà proprement les
// FK vers utilisateurs ; annonce_portails (CASCADE) gère la FK vers portails.
annoncesRouter.post('/diag-nettoyage-comptes-test', exigerConnexion, async (req, res) => {
    const emailsTest = [
        'test-audit@immo76.local', 'test-proxy@immo76.local', 'test-proxy2@immo76.local',
        'test-employe-role@immo76.local', 'test.diag.compte@plusimmo76.fr', 'test.diag.compte2@plusimmo76.fr',
        'test.diag.compte3@plusimmo76.fr', 'test.diag.h1.1@plusimmo76.fr', 'test.diag.h1.2@plusimmo76.fr',
        'test.diag.h1.3@plusimmo76.fr', 'test.diag.nobcrypt1@plusimmo76.fr', 'test.diag.nobcrypt2@plusimmo76.fr',
        'test.diag.nobcrypt3@plusimmo76.fr', 'test.diag.fixe@plusimmo76.fr',
    ];
    const emailsAGarder = ['naelbmks@gmail.com', 'nael.boumkais2@gmail.com'];
    try {
        const conflit = emailsTest.filter((e) => emailsAGarder.includes(e));
        if (conflit.length) return res.status(400).json({ erreur: `Conflit emails à garder/supprimer : ${conflit}` });

        const utilisateursSupprimes = [];
        for (const email of emailsTest) {
            const u = await db.prepare(`DELETE FROM utilisateurs WHERE email = ? RETURNING id, email`).get(email);
            if (u) utilisateursSupprimes.push(u);
        }

        const portailTest = await db.prepare(`SELECT id FROM portails WHERE nom = 'Test Diag Portail'`).get();
        let portailSupprime = null;
        if (portailTest) {
            const regleLiee = await db.prepare(`SELECT id FROM regles_routage WHERE portail_id = ?`).get(portailTest.id);
            const instanceLiee = await db.prepare(`SELECT id FROM annonce_portails WHERE portail_id = ? AND ad_id_externe IS NOT NULL`).get(portailTest.id);
            if (regleLiee) return res.status(400).json({ erreur: `Une règle de routage référence encore ce portail (id ${regleLiee.id}) — annulé.` });
            if (instanceLiee) return res.status(400).json({ erreur: `Une annonce a un ad_id_externe réel sur ce portail (instance ${instanceLiee.id}) — annulé.` });
            portailSupprime = await db.prepare(`DELETE FROM portails WHERE id = ? RETURNING id, nom`).get(portailTest.id);
        }

        const utilisateursRestants = await db.prepare(`SELECT id, email, role FROM utilisateurs ORDER BY id`).all();
        const portailsRestants = await db.prepare(`SELECT id, nom FROM portails ORDER BY id`).all();

        res.json({ utilisateursSupprimes, portailSupprime, utilisateursRestants, portailsRestants });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Colonnes explicites, sans `images`/`raw_data`/`donnees_ia` — Supervision (le seul appelant,
// voir Supervision.jsx) n'affiche qu'un tableau de statuts, jamais les photos. `images` seule
// peut peser plusieurs Mo par annonce (jusqu'à 20 photos en base64) : avec LIMIT 200 et un
// rafraîchissement automatique toutes les 5s pendant que l'onglet est ouvert, un `SELECT *` ici
// pouvait retransmettre plusieurs centaines de Mo par minute — identifié comme responsable
// d'un dépassement réel du quota de transfert Neon.
const COLONNES_LISTE_ANNONCES = 'id, external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, scrapee_le, est_annonce_test, alerte_document';

annoncesRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const annonces = q
            ? await db
                  .prepare(
                      `SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces
                       WHERE CAST(id AS TEXT) LIKE ? OR titre LIKE ? OR ville LIKE ?
                       ORDER BY scrapee_le DESC LIMIT 200`
                  )
                  .all(`%${q}%`, `%${q}%`, `%${q}%`)
            : await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces ORDER BY scrapee_le DESC LIMIT 200`).all();
        
        const getInstances = db.prepare(
            `SELECT ap.*, p.nom AS portail_nom
             FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
             WHERE ap.annonce_id = ?
             ORDER BY p.nom`
        );

        const result = [];
        for (const a of annonces) {
            result.push({
                ...a,
                portails: await getInstances.all(a.id),
            });
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id', exigerConnexion, async (req, res) => {
    try {
        const { est_annonce_test } = req.body;
        if (est_annonce_test === undefined) {
            return res.status(400).json({ erreur: 'est_annonce_test requis' });
        }
        await db.prepare(`UPDATE annonces SET est_annonce_test = ? WHERE id = ?`).run(est_annonce_test ? 1 : 0, req.params.id);
        // Réponse jamais lue côté frontend (voir Supervision.jsx, onToggleTest) — pas la peine
        // de retransmettre images/raw_data pour une ligne dont le résultat est ignoré.
        res.json(await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id/portails/:portailId', exigerConnexion, async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['brouillon', 'actif'].includes(mode)) {
            return res.status(400).json({ erreur: "mode doit être 'brouillon' ou 'actif'" });
        }
        await db.prepare(
            `UPDATE annonce_portails SET mode = ?, maj_le = CURRENT_TIMESTAMP
             WHERE annonce_id = ? AND portail_id = ?`
        ).run(mode, req.params.id, req.params.portailId);
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/republish', exigerConnexion, async (req, res) => {
    try {
        await publierInstance(Number(req.params.id), Number(req.params.portailId));
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/depublier', exigerConnexion, async (req, res) => {
    try {
        const result = await depublierInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/synchroniser', exigerConnexion, async (req, res) => {
    try {
        const result = await synchroniserInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
